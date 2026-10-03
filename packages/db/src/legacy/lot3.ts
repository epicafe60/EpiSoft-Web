import { readFileSync, existsSync } from 'node:fs';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { centsToDecimal, fiscalYearFor } from '@episoft/shared';
import type { Tx } from '../index';
import * as s from '../schema';
import type { Report } from './lot1';
import type { LegacySource } from './source';
import { legacyCents } from './transform-lot1';
import {
  accountSide,
  calendarYear,
  entryModeOf,
  lineDifference,
  matchInvoices,
  numberMovements,
  parseModels,
  planLines,
  sixDigitAccount,
  type MovementCandidate,
  type PlannedLine,
  hasNegativeAmount,
} from './transform-lot3';

// Legacy migration, lot 3 part (spec §9.1 step 8): accounting. Accounts, journals, fiscal
// years, movements and their lines, monthly "pointage", entry guides, bank rules.
//
// - Years before the current one are CLOSED and their entries VALIDATED; the current year stays
//   OPEN with DRAFT entries (spec §6). Validated entries get their number here, in date order.
// - Idempotent: movements are matched on legacy_mvtnum, guides on legacy_guinum. Rewriting
//   validated entries needs the guard bypass (the migration is the only one to use it).
// - `ecritures1` (old format, Oct–Dec 2025) is archived in the report and not migrated (Q7).

export const DEFAULT_MODELS_FILE = 'C:\\Datas\\Dev\\Episoft\\Datas\\Models.txt';

const BANK_ACCOUNT = '512001';

export async function migrateLot3(
  src: LegacySource,
  tx: Tx,
  r: Report,
  opts: { modelsFile?: string; today?: string } = {},
): Promise<void> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  // The migration rewrites validated entries of closed years: switch the guards off for this
  // transaction only (set_config is_local = true).
  await tx.execute(sql`select set_config('app.bypass_entry_guard', 'on', true)`);

  const accounts = await migrateAccounts(src, tx, r);
  const journals = await migrateJournals(src, tx, r);
  await migrateMovements(src, tx, r, accounts, journals, today);
  await linkSupplierInvoices(tx, r);
  await migrateGuides(src, tx, r, accounts, journals);
  await migrateBankRules(tx, r, opts.modelsFile ?? DEFAULT_MODELS_FILE);
  await archiveOldFormat(src, r);
}

type Ids = Map<string, string>;

async function migrateAccounts(src: LegacySource, tx: Tx, r: Report): Promise<Ids> {
  const rows = await src.query<{ CPTENUM: number; CPTETYPE: string; CPTELIB: string }>(
    'SELECT CPTENUM, CPTETYPE, CPTELIB FROM epicompta.comptes ORDER BY CPTENUM',
  );
  let migrated = 0;
  for (const a of rows) {
    const number = String(a.CPTENUM);
    if (!/^\d{6}$/.test(number)) {
      r.issues.push({
        entity: 'compte',
        legacyId: number,
        field: 'CPTENUM',
        value: number,
        problem: 'numéro différent de 6 chiffres',
        action: 'non repris',
      });
      continue;
    }
    const label = (a.CPTELIB ?? '').trim() || number;
    await tx
      .insert(s.account)
      .values({ number, label, normalSide: accountSide(a.CPTETYPE) })
      .onConflictDoUpdate({
        target: s.account.number,
        // Seeded accounts keep their own label; the legacy side and label complete them.
        set: { normalSide: accountSide(a.CPTETYPE), label },
      });
    migrated++;
  }
  r.counts.push({ table: 'compte', source: rows.length, migrated, note: 'plan comptable' });
  return new Map(
    (await tx.select({ id: s.account.id, number: s.account.number }).from(s.account)).map((a) => [
      a.number,
      a.id,
    ]),
  );
}

async function migrateJournals(src: LegacySource, tx: Tx, r: Report): Promise<Ids> {
  const rows = await src.query<{ JOURID: string; JOURLIB: string }>(
    'SELECT JOURID, JOURLIB FROM epicompta.journaux',
  );
  for (const [i, j] of rows.entries()) {
    const code = j.JOURID.trim();
    await tx
      .insert(s.journal)
      .values({ code, label: j.JOURLIB.trim(), sort: i })
      .onConflictDoUpdate({ target: s.journal.code, set: { label: j.JOURLIB.trim() } });
  }
  r.counts.push({ table: 'journal', source: rows.length, migrated: rows.length, note: '' });
  return new Map(
    (await tx.select({ id: s.journal.id, code: s.journal.code }).from(s.journal)).map((j) => [
      j.code,
      j.id,
    ]),
  );
}

interface Mvt {
  MVTNUM: number;
  MVTDATE: string;
  MVTJAL: string;
  MVTPIECE: string | null;
  MVTLIB: string | null;
  MVTRGLT: number;
  MVTRAPP: number;
  MVTVALIDE: number;
}

async function migrateMovements(
  src: LegacySource,
  tx: Tx,
  r: Report,
  accounts: Ids,
  journals: Ids,
  today: string,
) {
  const mvts = await src.query<Mvt>(
    'SELECT MVTNUM, MVTDATE, MVTJAL, MVTPIECE, MVTLIB, MVTRGLT, MVTRAPP, MVTVALIDE FROM epicompta.mouvements ORDER BY MVTNUM',
  );
  const ecr = await src.query<{
    ECRNUM: number;
    ECRCPTE: number;
    ECRLIB: string | null;
    ECRDEBIT: number | null;
    ECRCREDIT: number | null;
  }>('SELECT ECRNUM, ECRCPTE, ECRLIB, ECRDEBIT, ECRCREDIT FROM epicompta.ecritures');
  const linesOf = new Map<number, typeof ecr>();
  for (const e of ecr) linesOf.set(e.ECRNUM, [...(linesOf.get(e.ECRNUM) ?? []), e]);

  // Fiscal years: reuse any existing one covering the date, else create the calendar year.
  const years = await tx.select().from(s.fiscalYear);
  const yearOf = async (date: string) => {
    const found = fiscalYearFor(date, years);
    if (found) return found;
    const spec = calendarYear(date, today);
    const [created] = await tx
      .insert(s.fiscalYear)
      .values({
        ...spec,
        closedAt: spec.status === 'CLOSED' ? new Date() : null,
      })
      .returning();
    years.push(created!);
    r.counts.push({
      table: 'exercice',
      source: 0,
      migrated: 1,
      note: `${spec.label} créé (${spec.status === 'CLOSED' ? 'clôturé' : 'ouvert'})`,
    });
    return created!;
  };

  interface Prepared {
    m: Mvt;
    lines: PlannedLine[];
    year: (typeof years)[number];
    status: 'DRAFT' | 'VALIDATED';
  }
  const prepared: Prepared[] = [];
  const balanceIssues: object[] = [];
  for (const m of mvts) {
    const raw = (linesOf.get(m.MVTNUM) ?? []).map((l) => ({
      account: l.ECRCPTE,
      label: l.ECRLIB ?? '',
      debit: l.ECRDEBIT,
      credit: l.ECRCREDIT,
    }));
    const lines = planLines(raw);
    if (hasNegativeAmount(raw))
      r.issues.push({
        entity: 'mouvement',
        legacyId: String(m.MVTNUM),
        field: 'montant',
        value: `${m.MVTLIB ?? ''} ${m.MVTDATE}`,
        problem: 'montants négatifs (avoir saisi en négatif)',
        action: 'repris avec les montants portés du côté opposé',
      });
    if (lines.length < 2) {
      r.issues.push({
        entity: 'mouvement',
        legacyId: String(m.MVTNUM),
        field: 'ecritures',
        value: `${lines.length} ligne(s) — ${m.MVTLIB ?? ''} ${m.MVTDATE}`,
        problem: 'mouvement sans écritures exploitables',
        action: 'non repris',
      });
      continue;
    }
    if (lines.some((l) => !accounts.has(l.account))) {
      r.issues.push({
        entity: 'mouvement',
        legacyId: String(m.MVTNUM),
        field: 'ECRCPTE',
        value: lines.map((l) => l.account).join(', '),
        problem: 'compte inconnu du plan comptable',
        action: 'non repris',
      });
      continue;
    }
    const diff = lineDifference(lines);
    const year = await yearOf(m.MVTDATE);
    let status: Prepared['status'] = year.status === 'CLOSED' ? 'VALIDATED' : 'DRAFT';
    if (diff !== 0) {
      balanceIssues.push({
        mvtnum: m.MVTNUM,
        date: m.MVTDATE,
        label: m.MVTLIB,
        diff: centsToDecimal(diff),
      });
      r.issues.push({
        entity: 'mouvement',
        legacyId: String(m.MVTNUM),
        field: 'équilibre',
        value: centsToDecimal(diff),
        problem: 'déséquilibre après arrondi à 2 décimales',
        action: 'repris en brouillon, à corriger',
      });
      status = 'DRAFT';
    }
    if (m.MVTJAL.trim() === 'RAN' && lines.some((l) => l.account === '890000'))
      r.issues.push({
        entity: 'mouvement',
        legacyId: String(m.MVTNUM),
        field: 'ECRCPTE',
        value: '890000',
        problem: 'à-nouveau avec contrepartie 890000 (ancien mode de report)',
        action: 'repris tel quel ; la clôture v2 génère ses propres à-nouveaux',
      });
    prepared.push({ m, lines, year, status });
  }

  const numbers = numberMovements(
    prepared
      .filter((p) => p.status === 'VALIDATED')
      .map((p) => ({
        mvtnum: p.m.MVTNUM,
        date: p.m.MVTDATE,
        journal: p.m.MVTJAL.trim(),
        fiscalYear: p.year.id,
      })),
  );

  const entryIds = new Map<number, string>();
  for (const p of prepared) {
    const journalId = journals.get(p.m.MVTJAL.trim());
    if (!journalId) {
      r.issues.push({
        entity: 'mouvement',
        legacyId: String(p.m.MVTNUM),
        field: 'MVTJAL',
        value: p.m.MVTJAL,
        problem: 'journal inconnu',
        action: 'non repris',
      });
      continue;
    }
    const base = {
      journalId,
      fiscalYearId: p.year.id,
      date: p.m.MVTDATE,
      pieceRef: p.m.MVTPIECE?.trim() || null,
      label: (p.m.MVTLIB ?? '').trim() || `Mouvement ${p.m.MVTNUM}`,
      mode: entryModeOf(p.m.MVTRGLT),
    };
    const number = numbers.get(p.m.MVTNUM) ?? null;
    const [existing] = await tx
      .select({ id: s.entry.id })
      .from(s.entry)
      .where(eq(s.entry.legacyMvtnum, p.m.MVTNUM));
    let id: string;
    // Lines first as drafts would be simpler, but the guard allows everything under the bypass.
    if (existing) {
      id = existing.id;
      await tx.delete(s.entryLine).where(eq(s.entryLine.entryId, id));
      await tx
        .update(s.entry)
        .set({
          ...base,
          status: p.status,
          number,
          ...(p.status === 'VALIDATED' ? { validatedAt: new Date() } : {}),
        })
        .where(eq(s.entry.id, id));
    } else {
      [{ id }] = (await tx
        .insert(s.entry)
        .values({
          ...base,
          status: p.status,
          number,
          validatedAt: p.status === 'VALIDATED' ? new Date() : null,
          legacyMvtnum: p.m.MVTNUM,
        })
        .returning({ id: s.entry.id })) as [{ id: string }];
    }
    await tx.insert(s.entryLine).values(
      p.lines.map((l, i) => ({
        entryId: id,
        lineNo: i + 1,
        accountId: accounts.get(l.account)!,
        label: l.label,
        debit: centsToDecimal(l.debitCents),
        credit: centsToDecimal(l.creditCents),
      })),
    );
    entryIds.set(p.m.MVTNUM, id);
  }

  // Continue the numbering where the migration stopped.
  const perKey = new Map<string, number>();
  for (const p of prepared) {
    const n = numbers.get(p.m.MVTNUM);
    const journalId = journals.get(p.m.MVTJAL.trim());
    if (n && journalId) {
      const key = `entry:${journalId}:${p.year.id}`;
      perKey.set(key, Math.max(perKey.get(key) ?? 0, n));
    }
  }
  for (const [key, value] of perKey)
    await tx
      .insert(s.numberCounter)
      .values({ key, value })
      .onConflictDoUpdate({
        target: s.numberCounter.key,
        set: { value: sql`greatest(${s.numberCounter.value}, ${value})` },
      });

  await migrateReconciliations(tx, r, mvts, entryIds);
  r.counts.push({
    table: 'mouvement',
    source: mvts.length,
    migrated: entryIds.size,
    note: `${prepared.filter((p) => p.status === 'VALIDATED').length} validées, ${prepared.filter((p) => p.status === 'DRAFT').length} brouillons`,
  });
  r.counts.push({
    table: 'écriture',
    source: ecr.length,
    migrated: prepared.reduce((n, p) => n + p.lines.length, 0),
    note: 'lignes, montants arrondis à 2 décimales',
  });
  if (balanceIssues.length)
    r.sheets.push({
      name: 'Écritures déséquilibrées',
      columns: [
        { header: 'Mouvement', key: 'mvtnum', width: 12 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Libellé', key: 'label', width: 50 },
        { header: 'Écart', key: 'diff', width: 10 },
      ],
      rows: balanceIssues,
    });
  await trialBalanceSheet(src, tx, r, accounts);
}

/** MVTRAPP holds the statement month number: one "pointage" per value, on the bank lines. */
async function migrateReconciliations(
  tx: Tx,
  r: Report,
  mvts: Mvt[],
  entryIds: Map<number, string>,
) {
  const months = [...new Set(mvts.map((m) => m.MVTRAPP).filter((n) => n > 0))].sort(
    (a, b) => a - b,
  );
  let lines = 0;
  for (const n of months) {
    const label = `Pointage historique — relevé n° ${n}`;
    let [rec] = await tx.select().from(s.reconciliation).where(eq(s.reconciliation.label, label));
    if (!rec) [rec] = await tx.insert(s.reconciliation).values({ label }).returning();
    const ids = mvts
      .filter((m) => m.MVTRAPP === n && entryIds.has(m.MVTNUM))
      .map((m) => entryIds.get(m.MVTNUM)!);
    if (!ids.length) continue;
    const bankIds = tx
      .select({ id: s.account.id })
      .from(s.account)
      .where(like(s.account.number, '512%'));
    const updated = await tx
      .update(s.entryLine)
      .set({ reconciliationId: rec!.id })
      .where(sql`${s.entryLine.entryId} in ${ids} and ${s.entryLine.accountId} in ${bankIds}`)
      .returning({ id: s.entryLine.id });
    lines += updated.length;
  }
  r.counts.push({
    table: 'rapprochement',
    source: months.length,
    migrated: months.length,
    note: `${lines} lignes 512 pointées (un pointage historique par numéro de relevé)`,
  });
}

/** Source vs target balance per account: the check the treasurer reads (spec §9.2). */
async function trialBalanceSheet(src: LegacySource, tx: Tx, r: Report, accounts: Ids) {
  const source = await src.query<{ c: number; d: string; k: string }>(
    'SELECT ECRCPTE c, ROUND(SUM(ECRDEBIT), 2) d, ROUND(SUM(ECRCREDIT), 2) k FROM epicompta.ecritures GROUP BY ECRCPTE ORDER BY ECRCPTE',
  );
  const target = await tx.execute<{ number: string; d: string; k: string }>(sql`
    select a.number, sum(l.debit)::text d, sum(l.credit)::text k
    from app.entry_line l join app.account a on a.id = l.account_id
    join app.entry e on e.id = l.entry_id
    where e.legacy_mvtnum is not null
    group by a.number order by a.number`);
  const t = new Map(target.rows.map((x) => [x.number, x]));
  void accounts;
  r.sheets.push({
    name: 'Balance par compte',
    columns: [
      { header: 'Compte', key: 'account', width: 10 },
      { header: 'Débit source', key: 'sd', width: 14 },
      { header: 'Crédit source', key: 'sk', width: 14 },
      { header: 'Débit repris', key: 'td', width: 14 },
      { header: 'Crédit repris', key: 'tk', width: 14 },
      { header: 'Écart', key: 'gap', width: 10 },
    ],
    rows: source.map((x) => {
      const got = t.get(String(x.c));
      // Credit notes keyed as negative amounts move to the other side: compare the net balance.
      const gap = Math.abs(Number(x.d) - Number(x.k) - (Number(got?.d ?? 0) - Number(got?.k ?? 0)));
      return {
        account: String(x.c),
        sd: Number(x.d),
        sk: Number(x.k),
        td: Number(got?.d ?? 0),
        tk: Number(got?.k ?? 0),
        gap: Math.round(gap * 100) / 100,
      };
    }),
  });
}

/**
 * The supplier invoices migrated in lot 2 have no entry yet. The old accounting already holds
 * theirs (ACH journal): link them so that the application neither duplicates nor regenerates them.
 */
async function linkSupplierInvoices(tx: Tx, r: Report) {
  const invoices = await tx
    .select({
      id: s.supplierInvoice.id,
      date: s.supplierInvoice.date,
      total: s.supplierInvoice.totalIncl,
      account: s.supplier.accountNumber,
      status: s.supplierInvoice.status,
      paidAt: s.supplierInvoice.paidAt,
      entryId: s.supplierInvoice.entryId,
      paymentEntryId: s.supplierInvoice.paymentEntryId,
    })
    .from(s.supplierInvoice)
    .innerJoin(s.supplier, eq(s.supplier.id, s.supplierInvoice.supplierId));
  const candidates = (
    rows: { id: string; date: string; total: string; account: string | null }[],
  ) =>
    rows.map((i) => ({
      id: i.id,
      supplierAccount: i.account,
      date: i.date,
      totalCents: legacyCents(i.total),
    }));

  // Movements with a supplier line: credit of the ACH entry (invoice), debit of the payment.
  const supplierLines = await tx
    .select({
      entryId: s.entry.id,
      mvtnum: s.entry.legacyMvtnum,
      date: s.entry.date,
      journal: s.journal.code,
      account: s.account.number,
      debit: s.entryLine.debit,
      credit: s.entryLine.credit,
      source: s.entry.sourceType,
    })
    .from(s.entryLine)
    .innerJoin(s.entry, eq(s.entry.id, s.entryLine.entryId))
    .innerJoin(s.journal, eq(s.journal.id, s.entry.journalId))
    .innerJoin(s.account, eq(s.account.id, s.entryLine.accountId))
    .where(sql`${s.entry.legacyMvtnum} is not null and ${s.account.number} like '401%'`);
  const entryOf = new Map(supplierLines.map((l) => [l.mvtnum!, l.entryId]));

  const asMovements = (
    side: 'credit' | 'debit',
    journal: (j: string) => boolean,
  ): MovementCandidate[] =>
    supplierLines
      .filter((l) => journal(l.journal) && legacyCents(l[side]) > 0 && !l.source)
      .map((l) => ({
        mvtnum: l.mvtnum!,
        date: l.date,
        supplierAccount: l.account,
        cents: legacyCents(l[side]),
      }));

  const invoiceMatch = matchInvoices(
    asMovements('credit', (j) => j === 'ACH'),
    candidates(invoices.filter((i) => !i.entryId)),
  );
  for (const p of invoiceMatch.pairs) {
    const entryId = entryOf.get(p.mvtnum)!;
    await tx
      .update(s.entry)
      .set({ sourceType: 'invoice', sourceId: p.invoiceId })
      .where(eq(s.entry.id, entryId));
    await tx
      .update(s.supplierInvoice)
      .set({ entryId })
      .where(eq(s.supplierInvoice.id, p.invoiceId));
  }

  const paid = invoices.filter((i) => i.status === 'PAID' && !i.paymentEntryId);
  const paymentMatch = matchInvoices(
    asMovements('debit', (j) => j === 'BNQ' || j === 'CAI'),
    candidates(paid.map((i) => ({ ...i, date: i.paidAt ?? i.date }))),
  );
  for (const p of paymentMatch.pairs) {
    const entryId = entryOf.get(p.mvtnum)!;
    await tx
      .update(s.entry)
      .set({ sourceType: 'invoice_payment', sourceId: p.invoiceId })
      .where(eq(s.entry.id, entryId));
    await tx
      .update(s.supplierInvoice)
      .set({ paymentEntryId: entryId })
      .where(eq(s.supplierInvoice.id, p.invoiceId));
  }

  const unlinked = invoices.filter(
    (i) => !i.entryId && !invoiceMatch.pairs.some((p) => p.invoiceId === i.id),
  );
  for (const i of unlinked)
    r.issues.push({
      entity: 'facture',
      legacyId: i.id.slice(0, 8),
      field: 'écriture',
      value: `${i.date} ${i.total}`,
      problem: 'aucune écriture ACH correspondante dans l’ancienne comptabilité',
      action: 'l’écriture sera générée à la prochaine action sur la facture',
    });
  r.counts.push({
    table: 'facture ↔ écriture',
    source: invoices.length,
    migrated: invoiceMatch.pairs.length,
    note: `${paymentMatch.pairs.length} règlements rattachés, ${unlinked.length} factures sans écriture`,
  });
}

async function migrateGuides(src: LegacySource, tx: Tx, r: Report, accounts: Ids, journals: Ids) {
  const cats = await src.query<{ GUICATCODE: string; GUICATLIB: string; GUICATPOS: number }>(
    'SELECT GUICATCODE, GUICATLIB, GUICATPOS FROM epicompta.guidcat ORDER BY GUICATPOS',
  );
  for (const c of cats) {
    const values = { code: c.GUICATCODE.trim(), label: c.GUICATLIB.trim(), sort: c.GUICATPOS };
    await tx
      .insert(s.entryTemplateCategory)
      .values(values)
      .onConflictDoUpdate({ target: s.entryTemplateCategory.code, set: values });
  }
  const guides = await src.query<{
    GUINUM: number;
    GUICAT: string;
    GUIJAL: string;
    GUILIB: string;
    GUIRGLT: number;
    GUIACTIF: number;
  }>(
    'SELECT GUINUM, GUICAT, GUIJAL, GUILIB, GUIRGLT, GUIACTIF FROM epicompta.guides ORDER BY GUINUM',
  );
  const details = await src.query<{
    GUIDETNUM: number;
    GUIDETCPTE: number;
    GUIDETLIB: string | null;
    GUIDETDEB: number | null;
    GUIDETCRE: number | null;
    GUIDETORD: number;
  }>(
    'SELECT GUIDETNUM, GUIDETCPTE, GUIDETLIB, GUIDETDEB, GUIDETCRE, GUIDETORD FROM epicompta.guidetail ORDER BY GUIDETNUM, GUIDETORD',
  );
  // Accounts only the guides use (8-digit numbers shortened): created in the plan.
  for (const d of details) {
    const raw = String(d.GUIDETCPTE);
    const short = /^\d{8}$/.test(raw) ? raw.slice(0, 6) : null;
    if (!short || short.startsWith('512') || accounts.has(short)) continue;
    const label = (d.GUIDETLIB ?? '').trim() || short;
    const [created] = await tx
      .insert(s.account)
      .values({ number: short, label, normalSide: Number(d.GUIDETCRE) > 0 ? 'C' : 'D' })
      .onConflictDoNothing({ target: s.account.number })
      .returning({ id: s.account.id });
    const id =
      created?.id ??
      (await tx.select({ id: s.account.id }).from(s.account).where(eq(s.account.number, short)))[0]!
        .id;
    accounts.set(short, id);
    r.issues.push({
      entity: 'compte',
      legacyId: raw,
      field: 'GUIDETCPTE',
      value: short,
      problem: 'compte des guides absent du plan comptable',
      action: 'créé à 6 chiffres',
    });
  }
  const known = new Set(accounts.keys());
  let migrated = 0;
  for (const g of guides) {
    const journalId = journals.get(g.GUIJAL.trim());
    const lines = details.filter((d) => d.GUIDETNUM === g.GUINUM);
    const mapped = lines.map((d) => ({
      d,
      account: sixDigitAccount(d.GUIDETCPTE, known, BANK_ACCOUNT),
    }));
    const bad = mapped.find((m) => !m.account || !accounts.has(m.account));
    if (!journalId || bad || lines.length < 2) {
      r.issues.push({
        entity: 'guide',
        legacyId: String(g.GUINUM),
        field: bad ? 'GUIDETCPTE' : 'GUIJAL',
        value: bad ? String(bad.d.GUIDETCPTE) : g.GUIJAL,
        problem: bad ? 'compte sans équivalent à 6 chiffres' : 'journal inconnu ou guide incomplet',
        action: 'guide non repris',
      });
      continue;
    }
    const values = {
      categoryCode: g.GUICAT.trim(),
      journalId,
      label: g.GUILIB.trim(),
      mode: entryModeOf(g.GUIRGLT),
      active: g.GUIACTIF === 1,
      legacyGuinum: g.GUINUM,
    };
    const [tpl] = await tx
      .insert(s.entryTemplate)
      .values(values)
      .onConflictDoUpdate({ target: s.entryTemplate.legacyGuinum, set: values })
      .returning({ id: s.entryTemplate.id });
    await tx.delete(s.entryTemplateLine).where(eq(s.entryTemplateLine.templateId, tpl!.id));
    await tx.insert(s.entryTemplateLine).values(
      mapped.map(({ d, account }, i) => {
        const debit = legacyCents(d.GUIDETDEB);
        const credit = legacyCents(d.GUIDETCRE);
        return {
          templateId: tpl!.id,
          lineNo: i + 1,
          accountId: accounts.get(account!)!,
          label: (d.GUIDETLIB ?? '').trim(),
          debit: debit > 0 ? centsToDecimal(debit) : null,
          credit: credit > 0 ? centsToDecimal(credit) : null,
        };
      }),
    );
    migrated++;
  }
  r.counts.push({
    table: 'guide',
    source: guides.length,
    migrated,
    note: 'comptes à 8 chiffres ramenés à 6',
  });
}

/** R-CPT-13: Models.txt becomes editable bank rules ("REMISE DE CHEQUE" corrected to 511200, C15). */
async function migrateBankRules(tx: Tx, r: Report, file: string) {
  if (!existsSync(file)) {
    r.issues.push({
      entity: 'règle bancaire',
      legacyId: '',
      field: 'fichier',
      value: file,
      problem: 'Models.txt introuvable',
      action: 'règles non reprises',
    });
    return;
  }
  const buf = readFileSync(file);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  const rules = parseModels(text, BANK_ACCOUNT);
  const accountIds = new Map(
    (await tx.select({ id: s.account.id, number: s.account.number }).from(s.account)).map((a) => [
      a.number,
      a.id,
    ]),
  );
  const prefix = 'Reprise Models.txt — ';
  const existing = await tx
    .select({ id: s.bankRule.id })
    .from(s.bankRule)
    .where(like(s.bankRule.label, `${prefix}%`));
  if (existing.length)
    await tx.delete(s.bankRule).where(
      inArray(
        s.bankRule.id,
        existing.map((e) => e.id),
      ),
    );
  let migrated = 0;
  for (const rule of rules) {
    // C15: the old file credited the cards account for the cheque deposits.
    const counter = rule.text.toUpperCase().startsWith('REMISE DE CHEQUE')
      ? '511200'
      : rule.counterAccount;
    if (!accountIds.has(counter)) {
      const [created] = await tx
        .insert(s.account)
        .values({
          number: counter,
          label: `Compte repris de Models.txt (${rule.text})`,
          normalSide: 'D',
        })
        .onConflictDoNothing({ target: s.account.number })
        .returning({ id: s.account.id });
      if (created) accountIds.set(counter, created.id);
    }
    const counterId = accountIds.get(counter);
    if (!counterId) {
      r.issues.push({
        entity: 'règle bancaire',
        legacyId: rule.text,
        field: 'compte',
        value: counter,
        problem: 'compte absent du plan comptable',
        action: 'règle non reprise',
      });
      continue;
    }
    await tx.insert(s.bankRule).values({
      priority: rule.priority,
      label: `${prefix}${rule.text}`,
      pattern: rule.text,
      matchType: 'CONTAINS',
      direction: rule.direction,
      counterAccountId: counterId,
      mode: rule.mode,
      householdMatch: counter === '411000' && rule.direction === 'IN',
    });
    migrated++;
  }
  r.counts.push({
    table: 'règle bancaire',
    source: rules.length,
    migrated,
    note: 'Models.txt ; REMISE DE CHEQUE → 511200 (C15)',
  });
}

async function archiveOldFormat(src: LegacySource, r: Report) {
  const rows = await src.query<{
    ECRNUM: number;
    ECRDATE: string;
    ECRLIB: string | null;
    ECRCPTEDEB: number | null;
    ECRCPTECRE: number | null;
    ECRMNTDEB: number | null;
    ECRMNTCRED: number | null;
  }>(
    'SELECT ECRNUM, ECRDATE, ECRLIB, ECRCPTEDEB, ECRCPTECRE, ECRMNTDEB, ECRMNTCRED FROM epicompta.ecritures1 ORDER BY ECRNUM',
  );
  r.sheets.push({
    name: 'Archive ecritures1',
    columns: [
      { header: 'N°', key: 'num', width: 8 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Libellé', key: 'label', width: 40 },
      { header: 'Débit', key: 'deb', width: 10 },
      { header: 'Crédit', key: 'cre', width: 10 },
      { header: 'Montant débit', key: 'md', width: 12 },
      { header: 'Montant crédit', key: 'mc', width: 12 },
    ],
    rows: rows.map((x) => ({
      num: x.ECRNUM,
      date: x.ECRDATE,
      label: x.ECRLIB,
      deb: x.ECRCPTEDEB,
      cre: x.ECRCPTECRE,
      md: x.ECRMNTDEB,
      mc: x.ECRMNTCRED,
    })),
  });
  r.counts.push({
    table: 'ecritures1',
    source: rows.length,
    migrated: 0,
    note: 'archivé dans ce rapport, non repris (Q7 : à vérifier avec le trésorier)',
  });
}
