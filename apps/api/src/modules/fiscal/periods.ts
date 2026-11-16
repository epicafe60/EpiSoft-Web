import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { cashSession, periodClosing, sale, saleLine, salePayment, type DbOrTx } from '@episoft/db';
import {
  centsToDecimal,
  computePeriodTotals,
  decimalToCents,
  nextGrandTotal,
  type ClosingDoc,
  type PeriodTotals,
} from '@episoft/shared';
import { toShopDate, tzSql } from '../../lib/dates';
import { conflict } from '../../lib/problem';
import { appendJournal, lockPeriodExclusive } from './journal';

// ADR 0016, §3: day, month and year closings (« Z »), sealed in the journal, with the perpetual
// grand total. A closing is never changed nor repeated; its period takes no new ticket.

export type PeriodKind = 'DAY' | 'MONTH' | 'YEAR';

/** Last day (YYYY-MM-DD) of the period that starts on `start`: a day, a first of month or of January. */
export function periodEnd(kind: PeriodKind, start: string): string {
  const [y, m] = start.split('-').map(Number) as [number, number];
  if (kind === 'DAY') return start;
  const last = kind === 'MONTH' ? new Date(Date.UTC(y, m, 0)) : new Date(Date.UTC(y, 12, 0));
  return last.toISOString().slice(0, 10);
}

function validStart(kind: PeriodKind, start: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) return false;
  if (kind === 'MONTH') return start.endsWith('-01');
  if (kind === 'YEAR') return start.endsWith('-01-01');
  return true;
}

/** The documents counted on the days of the range, with their VAT lines and payments. */
export async function closingDocs(tx: DbOrTx, from: string, to: string): Promise<ClosingDoc[]> {
  const inRange = and(gte(sale.accountingDay, from), lte(sale.accountingDay, to));
  const sales = await tx
    .select({
      id: sale.id,
      number: sale.number,
      total: sale.total,
      cancels: sale.cancelsSaleId,
      returns: sale.returnsSaleId,
    })
    .from(sale)
    .where(inRange);
  if (!sales.length) return [];
  const vat = await tx
    .select({
      saleId: saleLine.saleId,
      rate: saleLine.vatRate,
      total: sql<string>`sum(${saleLine.lineTotal})::numeric(12,2)::text`,
    })
    .from(saleLine)
    .innerJoin(sale, eq(sale.id, saleLine.saleId))
    .where(inRange)
    .groupBy(saleLine.saleId, saleLine.vatRate);
  const pays = await tx
    .select({
      saleId: salePayment.saleId,
      method: salePayment.method,
      total: sql<string>`sum(${salePayment.amount})::numeric(12,2)::text`,
    })
    .from(salePayment)
    .innerJoin(sale, eq(sale.id, salePayment.saleId))
    .where(inRange)
    .groupBy(salePayment.saleId, salePayment.method);
  return sales.map((s) => ({
    number: s.number,
    kind: s.cancels ? ('CANCEL' as const) : s.returns ? ('RETURN' as const) : ('SALE' as const),
    totalCents: decimalToCents(s.total),
    vat: vat
      .filter((v) => v.saleId === s.id)
      .map((v) => ({ rate: String(Number(v.rate)), cents: decimalToCents(v.total) })),
    payments: pays
      .filter((p) => p.saleId === s.id)
      .map((p) => ({ method: p.method, cents: decimalToCents(p.total) })),
  }));
}

/** Days with documents, between two dates. */
export async function activeDays(tx: DbOrTx, from: string, to: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ day: sale.accountingDay })
    .from(sale)
    .where(and(gte(sale.accountingDay, from), lte(sale.accountingDay, to)))
    .orderBy(asc(sale.accountingDay));
  return rows.map((r) => r.day);
}

/** The perpetual grand total after the last day closed before `before`. */
export async function lastGrandTotal(tx: DbOrTx, before: string): Promise<string> {
  const [prev] = await tx
    .select({ grandTotal: periodClosing.grandTotal })
    .from(periodClosing)
    .where(and(eq(periodClosing.kind, 'DAY'), lt(periodClosing.periodStart, before)))
    .orderBy(sql`${periodClosing.periodStart} desc`)
    .limit(1);
  if (prev) return prev.grandTotal;
  // No closing yet: what was sold before counts in the perpetual total (history of the old till).
  const [row] = await tx
    .select({ abs: sql<string>`coalesce(sum(abs(${sale.total})), 0)::numeric(14,2)::text` })
    .from(sale)
    .where(lt(sale.accountingDay, before));
  return row!.abs;
}

export interface ClosePeriodInput {
  kind: PeriodKind;
  start: string;
  by: string | null;
  /** The closing instant (the clock by default). */
  now?: Date;
}

/**
 * Closes a period. Refuses what the rules refuse (twice, out of order, with a session still open,
 * with a day left open inside the month…) with a 409 whose message says what to do first.
 */
export async function closePeriod(tx: DbOrTx, input: ClosePeriodInput) {
  const { kind, start } = input;
  if (!validStart(kind, start)) throw conflict('Début de période invalide.');
  const end = periodEnd(kind, start);
  const closedAt = input.now ?? new Date();
  const today = toShopDate(closedAt);
  await lockPeriodExclusive(tx);

  const [already] = await tx
    .select({ id: periodClosing.id })
    .from(periodClosing)
    .where(and(eq(periodClosing.kind, kind), eq(periodClosing.periodStart, start)));
  if (already) throw conflict('Cette période est déjà clôturée : une clôture ne se refait pas.');

  let totals: PeriodTotals;
  let grandTotal: string;
  if (kind === 'DAY') {
    if (start > today) throw conflict('Une journée à venir ne se clôture pas.');
    const [later] = await tx
      .select({ day: periodClosing.periodStart })
      .from(periodClosing)
      .where(and(eq(periodClosing.kind, 'DAY'), gte(periodClosing.periodStart, start)))
      .limit(1);
    if (later)
      throw conflict(`Le ${later.day} est déjà clôturé : les journées se clôturent dans l’ordre.`);
    // Every drawer of the day (and before) is closed first: its tickets are all there.
    const open = await tx
      .select({ id: cashSession.id })
      .from(cashSession)
      .where(
        and(
          eq(cashSession.status, 'OPEN'),
          sql`(${cashSession.openedAt} at time zone ${tzSql()})::date <= ${start}::date`,
        ),
      )
      .limit(1);
    if (open.length)
      throw conflict('Une session de caisse est encore ouverte : clôturez la caisse d’abord.');
    const docs = await closingDocs(tx, start, start);
    if (!docs.length) throw conflict('Aucun ticket ce jour-là : rien à clôturer.');
    totals = computePeriodTotals(docs);
    grandTotal = nextGrandTotal(await lastGrandTotal(tx, start), totals.absoluteTotal);
  } else {
    if (end >= today) throw conflict('La période n’est pas terminée.');
    const days = await activeDays(tx, start, end);
    if (!days.length) throw conflict('Aucun ticket sur cette période : rien à clôturer.');
    const childKind = kind === 'MONTH' ? 'DAY' : 'MONTH';
    const closed = new Set(
      (
        await tx
          .select({ d: periodClosing.periodStart })
          .from(periodClosing)
          .where(
            and(
              eq(periodClosing.kind, childKind),
              gte(periodClosing.periodStart, start),
              lte(periodClosing.periodStart, end),
            ),
          )
      ).map((r) => r.d),
    );
    if (kind === 'MONTH') {
      const missing = days.filter((d) => !closed.has(d));
      if (missing.length) throw conflict(`Clôturez d’abord les journées : ${missing.join(', ')}.`);
    } else {
      const months = [...new Set(days.map((d) => `${d.slice(0, 7)}-01`))];
      const missing = months.filter((m) => !closed.has(m));
      if (missing.length)
        throw conflict(`Clôturez d’abord les mois : ${missing.map((m) => m.slice(0, 7)).join(', ')}.`);
    }
    totals = computePeriodTotals(await closingDocs(tx, start, end));
    // A month or a year does not add to the perpetual total: it carries the one of its last day.
    const [lastDay] = await tx
      .select({ grandTotal: periodClosing.grandTotal })
      .from(periodClosing)
      .where(
        and(
          eq(periodClosing.kind, 'DAY'),
          gte(periodClosing.periodStart, start),
          lte(periodClosing.periodStart, end),
        ),
      )
      .orderBy(sql`${periodClosing.periodStart} desc`)
      .limit(1);
    grandTotal = lastDay!.grandTotal;
  }

  const id = uuidv7();
  const { seq } = await appendJournal(tx, {
    kind: `CLOSING_${kind}`,
    refType: 'closing',
    refId: id,
    at: closedAt,
    data: {
      id,
      kind,
      start,
      end,
      totals,
      grandTotal: centsToDecimal(decimalToCents(grandTotal)),
      by: input.by,
    },
  });
  const [row] = await tx
    .insert(periodClosing)
    .values({
      id,
      kind,
      periodStart: start,
      periodEnd: end,
      closedAt,
      closedBy: input.by,
      tickets: totals.tickets,
      cancellations: totals.cancellations,
      returns: totals.returns,
      salesTotal: totals.salesTotal,
      refundsTotal: totals.refundsTotal,
      netTotal: totals.netTotal,
      grandTotal,
      totals,
      journalSeq: seq,
    })
    .returning();
  return row!;
}
