import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bankLine, bankStatement, entry, fiscalYear, type Db, type Tx } from '@episoft/db';
import {
  addDays,
  balanceOf,
  buildCarryForwardEntry,
  buildResultEntry,
  buildStockVariationEntry,
  centsToDecimal,
  closingSchema,
  decimalToCents,
  fiscalYearApproveSchema,
  fiscalYearReopenSchema,
  nextYearStart,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/problem';
import { stockValuation } from '../stock/valuation';
import {
  accountBalanceAt,
  accountBalances,
  accountMap,
  createEntry,
  fiscalYearAt,
  journalByCode,
  plannedToLines,
  validateEntries,
} from './service';

const idParams = { params: z.object({ id: z.string().uuid() }) };

export interface ClosingCheck {
  code: string;
  ok: boolean;
  /** An error blocks the closing; a warning is only shown. */
  severity: 'error' | 'warning';
  message: string;
}

async function closingChecks(db: Db | Tx, fy: typeof fiscalYear.$inferSelect) {
  const accounts = await accountMap(db);
  const checks: ClosingCheck[] = [];
  const [drafts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entry)
    .where(and(eq(entry.fiscalYearId, fy.id), eq(entry.status, 'DRAFT')));
  checks.push({
    code: 'DRAFTS',
    ok: drafts!.n === 0,
    severity: 'error',
    message:
      drafts!.n === 0
        ? 'Toutes les écritures sont validées.'
        : `${drafts!.n} écriture(s) en brouillon : validez-les ou supprimez-les.`,
  });

  const [unmatched] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bankLine)
    .where(
      and(
        eq(bankLine.status, 'NEW'),
        sql`${bankLine.date} between ${fy.startDate} and ${fy.endDate}`,
      ),
    );
  const [openStatements] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bankStatement)
    .where(
      and(
        eq(bankStatement.status, 'OPEN'),
        sql`${bankStatement.periodEnd} between ${fy.startDate} and ${fy.endDate}`,
      ),
    );
  checks.push({
    code: 'BANK',
    ok: unmatched!.n === 0 && openStatements!.n === 0,
    severity: 'error',
    message:
      unmatched!.n === 0 && openStatements!.n === 0
        ? 'Les relevés bancaires sont rapprochés.'
        : `${unmatched!.n} ligne(s) bancaire(s) à rapprocher, ${openStatements!.n} relevé(s) non clos.`,
  });

  const balances = await accountBalances(db, { fiscalYearId: fy.id });
  const debit = balances.reduce((s, b) => s + b.debitCents, 0);
  const credit = balances.reduce((s, b) => s + b.creditCents, 0);
  checks.push({
    code: 'BALANCED',
    ok: debit === credit,
    severity: 'error',
    message:
      debit === credit
        ? 'La balance est équilibrée.'
        : `La balance est déséquilibrée de ${centsToDecimal(Math.abs(debit - credit))} €.`,
  });

  const [previous] = await db
    .select()
    .from(fiscalYear)
    .where(and(ne(fiscalYear.id, fy.id), sql`${fiscalYear.endDate} < ${fy.startDate}`))
    .orderBy(desc(fiscalYear.endDate))
    .limit(1);
  checks.push({
    code: 'PREVIOUS',
    ok: !previous || previous.status === 'CLOSED',
    severity: 'error',
    message:
      !previous || previous.status === 'CLOSED'
        ? 'L’exercice précédent est clôturé.'
        : `L’exercice ${previous.label} doit être clôturé d’abord.`,
  });

  const suspense = balances.find((b) => b.number === '890000');
  const suspenseCents = suspense ? balanceOf(suspense) : 0;
  checks.push({
    code: 'OPENING',
    ok: suspenseCents === 0,
    severity: 'warning',
    message:
      suspenseCents === 0
        ? 'Le compte de bilan d’ouverture (890000) est soldé.'
        : `Le compte 890000 n’est pas soldé (${centsToDecimal(suspenseCents)} €) : vérifiez les à-nouveaux.`,
  });

  const stockNow = await accountBalanceAt(db, accounts.stock, fy.endDate);
  const valued = await stockValuation(db, fy.endDate, 'excl');
  return {
    checks,
    canClose: fy.status === 'OPEN' && checks.every((c) => c.ok || c.severity === 'warning'),
    stock: {
      accountCents: stockNow,
      account: centsToDecimal(stockNow),
      valuation: valued.total,
    },
  };
}

export const closingRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const compta = { preHandler: app.requireRoles('COMPTA') };
  const admin = { preHandler: app.requireRoles('ADMIN') };

  /**
   * R-EVO-51: the opening balances (journal RAN) of a year against the closing balances of the
   * previous one, account by account (balance sheet classes 1 to 5). Used to check the carry-over
   * before keying the first months of the new year (e.g. July to September after a June closing).
   */
  app.get('/fiscal-years/:id/opening-check', { ...compta, schema: idParams }, async (req) => {
    const [fy] = await db.select().from(fiscalYear).where(eq(fiscalYear.id, req.params.id));
    if (!fy) throw notFound('Exercice introuvable.');
    const [previous] = await db
      .select()
      .from(fiscalYear)
      .where(and(ne(fiscalYear.id, fy.id), sql`${fiscalYear.endDate} < ${fy.startDate}`))
      .orderBy(desc(fiscalYear.endDate))
      .limit(1);
    if (!previous)
      return { previous: null, previousStatus: null, rows: [], ok: true, differences: 0 };
    const ran = await journalByCode(db, 'RAN');
    const [prevBalances, openBalances] = await Promise.all([
      accountBalances(db, { fiscalYearId: previous.id, status: 'VALIDATED' }),
      ran
        ? accountBalances(db, { fiscalYearId: fy.id, status: 'VALIDATED', journalId: ran.id })
        : Promise.resolve([]),
    ]);
    const cls = (n: string) => Number(n.slice(0, 1));
    const closing = new Map(
      prevBalances.filter((b) => cls(b.number) <= 5).map((b) => [b.number, b]),
    );
    const opening = new Map(
      openBalances.filter((b) => cls(b.number) <= 5).map((b) => [b.number, b]),
    );
    const numbers = [...new Set([...closing.keys(), ...opening.keys()])].sort();
    const rows = numbers
      .map((n) => {
        const c = closing.get(n);
        const o = opening.get(n);
        const closingCents = c ? balanceOf(c) : 0;
        const openingCents = o ? balanceOf(o) : 0;
        return {
          number: n,
          label: (c ?? o)!.label,
          closing: centsToDecimal(closingCents),
          opening: centsToDecimal(openingCents),
          difference: centsToDecimal(openingCents - closingCents),
        };
      })
      .filter((r) => r.closing !== '0.00' || r.opening !== '0.00');
    const differences = rows.filter((r) => r.difference !== '0.00').length;
    return {
      previous: previous.label,
      previousStatus: previous.status,
      rows,
      ok: differences === 0,
      differences,
    };
  });

  app.get('/fiscal-years/:id/closing-check', { ...compta, schema: idParams }, async (req) => {
    const [fy] = await db.select().from(fiscalYear).where(eq(fiscalYear.id, req.params.id));
    if (!fy) throw notFound('Exercice introuvable.');
    return { status: fy.status, ...(await closingChecks(db, fy)) };
  });

  /**
   * R-CPT-18: stock variation, result allocation, carry-forward (à-nouveaux) and lock, in one
   * transaction. Everything is validated at once; the carry-forward is unique per year.
   */
  app.post(
    '/fiscal-years/:id/close',
    { ...compta, schema: { ...idParams, body: closingSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [fy] = await tx
          .select()
          .from(fiscalYear)
          .where(eq(fiscalYear.id, req.params.id))
          .for('update');
        if (!fy) throw notFound('Exercice introuvable.');
        if (fy.status !== 'OPEN') throw conflict('Cet exercice est déjà clôturé.');
        const { checks } = await closingChecks(tx, fy);
        const blocking = checks.find((c) => !c.ok && c.severity === 'error');
        if (blocking) throw conflict(blocking.message);

        const accounts = await accountMap(tx);
        const created: string[] = [];

        // 1. Stock variation: brings 370000 to the valued inventory.
        const target = req.body.stockValue
          ? decimalToCents(req.body.stockValue)
          : decimalToCents((await stockValuation(tx, fy.endDate, 'excl')).total);
        const current = await accountBalanceAt(tx, accounts.stock, fy.endDate);
        const stockLines = buildStockVariationEntry(current, target, accounts);
        if (stockLines.length) {
          created.push(
            await createEntry(tx, {
              journalCode: 'OD',
              date: fy.endDate,
              label: `Variation de stock ${fy.label}`,
              lines: plannedToLines(stockLines),
              source: { type: 'closing_stock', id: fy.id },
              userId: req.user!.id,
            }),
          );
        }
        await validateEntries(tx, created, req.user!.id);

        // 2. Result: classes 6 and 7 are zeroed against 120000 / 129000.
        const resultBalances = await accountBalances(tx, {
          fiscalYearId: fy.id,
          status: 'VALIDATED',
        });
        const resultLines = buildResultEntry(resultBalances, accounts);
        let resultEntryId: string | null = null;
        if (resultLines.length > 1) {
          resultEntryId = await createEntry(tx, {
            journalCode: 'OD',
            date: fy.endDate,
            label: `Affectation du résultat ${fy.label}`,
            lines: plannedToLines(resultLines),
            source: { type: 'closing_result', id: fy.id },
            userId: req.user!.id,
          });
          await validateEntries(tx, [resultEntryId], req.user!.id);
        }

        // 3. Lock the year, then carry the balance sheet forward to the next one.
        await tx
          .update(fiscalYear)
          .set({ status: 'CLOSED', closedAt: new Date(), closedBy: req.user!.id })
          .where(eq(fiscalYear.id, fy.id));

        const start = nextYearStart(fy.endDate);
        let next: typeof fiscalYear.$inferSelect | null = await fiscalYearAt(tx, start);
        if (!next) {
          const year = Number(start.slice(0, 4));
          const end = addDays(`${year + 1}-${start.slice(5)}`, -1);
          [next = null] = await tx
            .insert(fiscalYear)
            .values({ label: `Exercice ${year}`, startDate: start, endDate: end })
            .returning();
        }
        const finalBalances = await accountBalances(tx, {
          fiscalYearId: fy.id,
          status: 'VALIDATED',
        });
        const ranLines = buildCarryForwardEntry(finalBalances);
        let ranEntryId: string | null = null;
        if (ranLines.length && next!.status === 'OPEN') {
          ranEntryId = await createEntry(tx, {
            journalCode: 'RAN',
            date: start,
            label: `À-nouveaux ${next!.label}`,
            lines: plannedToLines(ranLines),
            source: { type: 'closing_ran', id: fy.id },
            userId: req.user!.id,
          });
          await validateEntries(tx, [ranEntryId], req.user!.id);
        }

        await audit(tx, req, {
          action: 'fiscal_year.close',
          entity: 'fiscal_year',
          entityId: fy.id,
          after: { stockEntries: created.length, resultEntryId, ranEntryId },
        });
        return { resultEntryId, ranEntryId, nextFiscalYearId: next!.id };
      }),
  );

  /**
   * Reopening is exceptional (ADMIN, audited, motif required) and only possible for the latest
   * closed year, as long as the general assembly has not approved its accounts: an approved year
   * is inalterable (art. L123-22 Code de commerce), corrections go to the current year. The closing
   * entries are removed so the year can be corrected and closed again.
   */
  app.post(
    '/fiscal-years/:id/reopen',
    { ...admin, schema: { ...idParams, body: fiscalYearReopenSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [fy] = await tx
          .select()
          .from(fiscalYear)
          .where(eq(fiscalYear.id, req.params.id))
          .for('update');
        if (!fy) throw notFound('Exercice introuvable.');
        if (fy.status !== 'CLOSED') throw conflict('Cet exercice n’est pas clôturé.');
        if (fy.approvedAt)
          throw conflict(
            `Les comptes de l’exercice ${fy.label} ont été approuvés par l’assemblée générale : il ne peut plus être rouvert. Passez les corrections dans l’exercice en cours.`,
          );
        const [laterClosed] = await tx
          .select({ label: fiscalYear.label })
          .from(fiscalYear)
          .where(and(gt(fiscalYear.startDate, fy.endDate), eq(fiscalYear.status, 'CLOSED')));
        if (laterClosed)
          throw conflict(
            `Seul le dernier exercice clôturé peut être rouvert : ${laterClosed.label} est clôturé après celui-ci.`,
          );
        const [later] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(entry)
          .innerJoin(fiscalYear, eq(fiscalYear.id, entry.fiscalYearId))
          .where(
            and(
              gt(fiscalYear.startDate, fy.endDate),
              sql`${entry.sourceType} is distinct from 'closing_ran'`,
            ),
          );
        if (later!.n > 0)
          throw conflict('L’exercice suivant contient déjà des écritures : rouvrez-le d’abord.');

        // The closing entries are validated: the application's role cannot delete them. The database
        // does it, for a closed and not approved year only, with the rights of its owner (migration
        // 0031, 0041). It also sets the numbering counters back, so no number is left missing.
        const { rows } = await tx.execute<{ removed: number }>(
          sql`select app.remove_closing_entries(${fy.id}::uuid) as removed`,
        );
        const removed = rows[0]!.removed;
        await tx
          .update(fiscalYear)
          .set({ status: 'OPEN', closedAt: null, closedBy: null })
          .where(eq(fiscalYear.id, fy.id));
        await audit(tx, req, {
          action: 'fiscal_year.reopen',
          entity: 'fiscal_year',
          entityId: fy.id,
          after: { removedEntries: removed, reason: req.body.reason },
        });
        return { removed };
      }),
  );

  /**
   * Approval of the accounts by the general assembly: date and reference of the minutes. From then
   * on the year can never be reopened (a trigger of the database refuses it too).
   */
  app.post(
    '/fiscal-years/:id/approve',
    { ...compta, schema: { ...idParams, body: fiscalYearApproveSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [fy] = await tx
          .select()
          .from(fiscalYear)
          .where(eq(fiscalYear.id, req.params.id))
          .for('update');
        if (!fy) throw notFound('Exercice introuvable.');
        if (fy.status !== 'CLOSED')
          throw conflict('Seul un exercice clôturé peut être approuvé par l’assemblée générale.');
        if (fy.approvedAt) throw conflict('Les comptes de cet exercice sont déjà approuvés.');
        if (req.body.date <= fy.endDate)
          throw conflict('L’assemblée générale se tient après la fin de l’exercice.');
        await tx
          .update(fiscalYear)
          .set({
            approvedOn: req.body.date,
            approvedAt: new Date(),
            approvedBy: req.user!.id,
            approvalReference: req.body.reference,
          })
          .where(eq(fiscalYear.id, fy.id));
        await audit(tx, req, {
          action: 'fiscal_year.approve',
          entity: 'fiscal_year',
          entityId: fy.id,
          after: { date: req.body.date, reference: req.body.reference },
        });
        return { ok: true };
      }),
  );
};
