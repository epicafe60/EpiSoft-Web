import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { account, entry, entryLine, type Db, type DbOrTx, type Tx } from '@episoft/db';
import {
  buildSessionEntry,
  centsToDecimal,
  decimalToCents,
  defaultProposalStart,
  linesSignature,
  proposalState,
  salesPeriodOf,
  type MoneyMethod,
  type PaymentMethod,
  type PlannedLine,
  type ProposalState,
  type SalesPeriod,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toParisDate } from '../../lib/dates';
import { badRequest } from '../../lib/problem';
import {
  accountMap,
  createEntry,
  entryBySource,
  plannedToLines,
  replaceDraftLines,
} from './service';

// Entries proposed to the treasurer from the cash sessions that no entry covers yet (sales by
// payment method, revenue by account, cagnotte top-ups, cash difference). The treasurer picks
// what to generate; only drafts are ever created or refreshed, never validated entries.

const SOURCE = 'sales_period';

const query = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  grouping: z.enum(['WEEK', 'DAY']).default('WEEK'),
});

interface SessionRef {
  id: string;
  day: string;
}

export interface Proposal {
  key: string;
  label: string;
  from: string;
  to: string;
  /** Date the entry gets: the last day with a session in the period. */
  entryDate: string;
  sessions: number;
  state: ProposalState;
  entryId: string | null;
  entryNumber: string | null;
  totalCents: number;
  lines: PlannedLine[];
  /** Credit added to the sales account to balance the entry (0 when the figures agree). */
  adjustmentCents: number;
  /** Total of the existing entry, when it differs (to show the change). */
  existingTotalCents: number | null;
}

/** Closed sessions not covered by their own entry, by Paris closing day, within [from, to]. */
async function eligibleSessions(db: DbOrTx, from: string, to: string): Promise<SessionRef[]> {
  const res = await db.execute<{ id: string; day: string }>(sql`
    select s.id, to_char(s.closed_at at time zone 'Europe/Paris', 'YYYY-MM-DD') as day
      from app.cash_session s
     where s.status = 'CLOSED' and s.closed_at is not null and s.entry_id is null
       and not exists (select 1 from app.entry e where e.source_type = 'session' and e.source_id = s.id::text)
       and (s.closed_at at time zone 'Europe/Paris')::date between ${from}::date and ${to}::date
     order by s.closed_at`);
  return res.rows;
}

/** The figures of a set of sessions, as buildSessionEntry expects them. */
async function planLines(
  db: DbOrTx,
  ids: string[],
  period: SalesPeriod,
): Promise<{ lines: PlannedLine[]; adjustmentCents: number }> {
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const pays = await db.execute<{ method: PaymentMethod; cents: string }>(sql`
    select p.method, coalesce(sum(p.amount), 0)::text as cents
      from app.sale_payment p join app.sale s on s.id = p.sale_id
     where s.session_id in (${list}) group by p.method`);
  const payments: Partial<Record<PaymentMethod, number>> = {};
  for (const p of pays.rows) payments[p.method] = decimalToCents(p.cents);

  const a = await accountMap(db);
  const rev = await db.execute<{ kind: string; account: string | null; cents: string }>(sql`
    select case when exists (select 1 from app.membership_type mt where mt.product_id = p.id) then 'MEMBERSHIP'
                when p.code = '01004' then 'DONATION' else 'SALES' end as kind,
           c.sales_account_number as account,
           coalesce(sum(l.line_total), 0)::text as cents
      from app.sale s
      join app.sale_line l on l.sale_id = s.id
      join app.product p on p.id = l.product_id
      left join app.category c on c.id = p.category_id
     where s.session_id in (${list})
     group by 1, 2`);
  const revenue: Record<string, number> = {};
  for (const r of rev.rows) {
    const acct =
      r.kind === 'MEMBERSHIP'
        ? a.memberships
        : r.kind === 'DONATION'
          ? a.donations
          : (r.account ?? a.sales);
    revenue[acct] = (revenue[acct] ?? 0) + decimalToCents(r.cents);
  }

  // Top-ups: taken at the till (linked to a session) or, for the history, dated inside the period.
  const tops = await db.execute<{ method: MoneyMethod; cents: string }>(sql`
    select m.method, coalesce(sum(m.amount), 0)::text as cents
      from app.member_payment m
     where m.purpose = 'TOPUP' and m.method is not null and m.method <> 'WALLET'
       and (m.cash_session_id in (${list})
            or (m.cash_session_id is null and m.legacy_payid is not null
                and m.date between ${period.from}::date and ${period.to}::date))
     group by m.method`);
  const topups: Partial<Record<MoneyMethod, number>> = {};
  for (const t of tops.rows) topups[t.method] = decimalToCents(t.cents);

  const diff = await db.execute<{ d: string }>(sql`
    select coalesce(sum(c.difference), 0)::text as d from app.cash_count c where c.session_id in (${list})`);
  const lines = buildSessionEntry(
    { payments, revenue, topups, cashDifferenceCents: decimalToCents(diff.rows[0]?.d ?? '0') },
    a,
  );
  // Tickets migrated from the old application can carry lines that differ from what was paid
  // (VTE-05), and cents can drift: the difference goes to the sales account, visibly, so the
  // entry balances and the treasurer sees how much was adjusted.
  const gap = lines.reduce((n, l) => n + l.debitCents - l.creditCents, 0);
  if (gap !== 0)
    lines.push({
      account: a.sales,
      label: 'Ajustement ventes (écarts de reprise et d’arrondi)',
      debitCents: gap < 0 ? -gap : 0,
      creditCents: gap > 0 ? gap : 0,
    });
  return { lines, adjustmentCents: gap };
}

async function existingLines(db: DbOrTx, entryId: string): Promise<PlannedLine[]> {
  const rows = await db
    .select({ number: account.number, debit: entryLine.debit, credit: entryLine.credit })
    .from(entryLine)
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(eq(entryLine.entryId, entryId));
  return rows.map((r) => ({
    account: r.number,
    label: '',
    debitCents: decimalToCents(r.debit),
    creditCents: decimalToCents(r.credit),
  }));
}

/** Every period of [from, to] with sessions to account for, and what to do with each. */
export async function buildProposals(
  db: DbOrTx,
  from: string,
  to: string,
  grouping: 'WEEK' | 'DAY',
): Promise<Proposal[]> {
  const sessions = await eligibleSessions(db, from, to);
  const periods = new Map<string, { period: SalesPeriod; sessions: SessionRef[] }>();
  for (const s of sessions) {
    const p = salesPeriodOf(s.day, grouping);
    const g = periods.get(p.key) ?? { period: p, sessions: [] };
    g.sessions.push(s);
    periods.set(p.key, g);
  }
  const out: Proposal[] = [];
  for (const { period, sessions: list } of periods.values()) {
    const { lines, adjustmentCents } = await planLines(
      db,
      list.map((s) => s.id),
      period,
    );
    if (!lines.length) continue;
    const existing = await entryBySource(db, SOURCE, period.key);
    const current = existing ? await existingLines(db, existing.id) : [];
    const same = existing ? linesSignature(current) === linesSignature(lines) : false;
    out.push({
      key: period.key,
      label: period.label,
      from: period.from,
      to: period.to,
      entryDate: list
        .map((s) => s.day)
        .sort()
        .at(-1)!,
      sessions: list.length,
      state: proposalState(existing ? { status: existing.status } : null, same),
      entryId: existing?.id ?? null,
      entryNumber: existing?.number ? String(existing.number) : null,
      totalCents: lines.reduce((n, l) => n + l.debitCents, 0),
      lines,
      adjustmentCents,
      existingTotalCents: existing && !same ? current.reduce((n, l) => n + l.debitCents, 0) : null,
    });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

export const proposalRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const compta = { preHandler: app.requireRoles('COMPTA') };

  app.get('/accounting/proposals', { ...compta, schema: { querystring: query } }, async (req) => {
    const today = toParisDate(new Date());
    // Default start: the day after the last entry not produced by this tool (old accounting…).
    const [last] = (
      await db.execute<{ d: string | null }>(sql`
        select max(e.date)::text as d from app.entry e join app.journal j on j.id = e.journal_id
         where j.code = 'VTE' and (e.source_type is null or e.source_type <> ${SOURCE})`)
    ).rows;
    const [first] = (
      await db.execute<{ d: string | null }>(sql`
        select min((s.closed_at at time zone 'Europe/Paris')::date)::text as d
          from app.cash_session s where s.status = 'CLOSED' and s.entry_id is null`)
    ).rows;
    const defaultFrom = defaultProposalStart(last?.d ?? null, first?.d ?? null) ?? today;
    const from = req.query.from ?? defaultFrom;
    const to = req.query.to ?? today;
    const proposals = await buildProposals(db, from, to, req.query.grouping);
    // Entries of the old accounting already inside the range: a risk of counting twice.
    const [overlap] = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from app.entry e join app.journal j on j.id = e.journal_id
         where j.code = 'VTE' and (e.source_type is null or e.source_type <> ${SOURCE})
           and e.date between ${from}::date and ${to}::date`)
    ).rows;
    return {
      from,
      to,
      defaultFrom,
      grouping: req.query.grouping,
      overlappingEntries: overlap?.n ?? 0,
      proposals: proposals.map((p) => ({
        ...p,
        total: centsToDecimal(p.totalCents),
        adjustment: centsToDecimal(p.adjustmentCents),
        existingTotal: p.existingTotalCents === null ? null : centsToDecimal(p.existingTotalCents),
        lines: p.lines.map((l) => ({
          account: l.account,
          label: l.label,
          debit: centsToDecimal(l.debitCents),
          credit: centsToDecimal(l.creditCents),
        })),
      })),
    };
  });

  /** Creates the draft of each chosen period, or refreshes its draft when the sales changed. */
  app.post(
    '/accounting/proposals/generate',
    {
      ...compta,
      schema: {
        body: z.object({
          from: z.string().date(),
          to: z.string().date(),
          grouping: z.enum(['WEEK', 'DAY']),
          keys: z.array(z.string().max(30)).min(1).max(200),
        }),
      },
    },
    async (req) =>
      db.transaction(async (tx: Tx) => {
        const b = req.body;
        const all = await buildProposals(tx, b.from, b.to, b.grouping);
        const wanted = b.keys.map((k) => all.find((p) => p.key === k));
        if (wanted.some((p) => !p))
          throw badRequest('Une proposition a changé : recalculez puis recommencez.');
        let created = 0;
        let updated = 0;
        const skipped: string[] = [];
        for (const p of wanted as Proposal[]) {
          if (p.state === 'NEW') {
            await createEntry(tx, {
              journalCode: 'VTE',
              date: p.entryDate,
              label: p.label,
              pieceRef: null,
              mode: 'OTHER',
              lines: plannedToLines(p.lines),
              source: { type: SOURCE, id: p.key },
              userId: req.user!.id,
              autoFiscalYear: true,
            });
            created++;
          } else if (p.state === 'OUTDATED_DRAFT' && p.entryId) {
            const numbers = p.lines.map((l) => l.account);
            const accounts = await tx
              .select({ id: account.id, number: account.number })
              .from(account)
              .where(inArray(account.number, numbers));
            await replaceDraftLines(
              tx,
              p.entryId,
              p.lines.map((l) => ({
                accountId: accounts.find((x) => x.number === l.account)!.id,
                label: l.label,
                debitCents: l.debitCents,
                creditCents: l.creditCents,
              })),
            );
            await tx
              .update(entry)
              .set({ date: p.entryDate, label: p.label })
              .where(and(eq(entry.id, p.entryId), eq(entry.status, 'DRAFT')));
            updated++;
          } else skipped.push(p.key);
        }
        await audit(tx, req, {
          action: 'accounting.proposals',
          entity: 'entry',
          after: { created, updated, skipped: skipped.length, grouping: b.grouping },
        });
        return { created, updated, skipped };
      }),
  );
};
