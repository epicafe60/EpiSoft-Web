import { and, asc, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  fiscalJournal,
  periodClosing,
  sale,
  saleLine,
  salePayment,
  ticketReprint,
  type DbOrTx,
} from '@episoft/db';
import { buildArchive, normDecimal, normInstant, type FiscalArchive } from '@episoft/shared';
import { tzSql } from '../../lib/dates';
import { fiscalSealKey } from './journal';

// ADR 0016 §8: the archive a controller reads. Everything is written in the canonical form the
// hashes were made from (decimals without useless zeros, instants in UTC), so that the file
// verifies on its own.

const dec = (v: string | null) => (v == null ? null : normDecimal(v));

export async function buildFiscalArchive(
  db: DbOrTx,
  from: string,
  to: string,
  now = new Date(),
): Promise<FiscalArchive> {
  const sales = await db
    .select()
    .from(sale)
    .where(and(gte(sale.accountingDay, from), lte(sale.accountingDay, to)))
    .orderBy(asc(sale.soldAt), asc(sale.number));
  const ids = sales.map((s) => s.id);
  const lines = ids.length
    ? await db
        .select()
        .from(saleLine)
        .where(inArray(saleLine.saleId, ids))
        .orderBy(asc(saleLine.saleId), asc(saleLine.lineNo))
    : [];
  const pays = ids.length
    ? await db
        .select()
        .from(salePayment)
        .where(inArray(salePayment.saleId, ids))
        .orderBy(asc(salePayment.saleId), asc(salePayment.method), asc(salePayment.amount))
    : [];
  const closings = await db
    .select()
    .from(periodClosing)
    .where(and(lte(periodClosing.periodStart, to), gte(periodClosing.periodEnd, from)))
    .orderBy(asc(periodClosing.periodStart), asc(periodClosing.kind));
  const reprints = ids.length
    ? await db
        .select()
        .from(ticketReprint)
        .where(inArray(ticketReprint.saleId, ids))
        .orderBy(asc(ticketReprint.at))
    : [];
  // The journal of the same days (by the instant of the event, in the shop's day).
  const journal = await db
    .select()
    .from(fiscalJournal)
    .where(
      sql`(${fiscalJournal.at} at time zone ${tzSql()})::date between ${from}::date and ${to}::date`,
    )
    .orderBy(asc(fiscalJournal.seq));

  return buildArchive(
    {
      sales: sales.map((s) => ({
        id: s.id,
        number: s.number,
        registerNumber: s.provisionalNumber,
        registerSeq: s.registerSeq,
        tillHash: s.tillHash,
        tillSealStatus: s.tillSealStatus,
        deviceId: s.deviceId,
        sessionId: s.sessionId,
        soldAt: normInstant(s.soldAt),
        accountingDay: s.accountingDay,
        cashierId: s.cashierId,
        memberId: s.memberId,
        total: dec(s.total),
        status: s.status,
        cancelsSaleId: s.cancelsSaleId,
        returnsSaleId: s.returnsSaleId,
        returnReason: s.returnReason,
        refundMethod: s.refundMethod,
      })),
      saleLines: lines.map((l) => ({
        saleId: l.saleId,
        lineNo: l.lineNo,
        productId: l.productId,
        label: l.label,
        qty: dec(l.qty),
        unitPrice: dec(l.unitPrice),
        discount: dec(l.discount),
        lineTotal: dec(l.lineTotal),
        vatRate: dec(l.vatRate),
        returnsLineId: l.returnsLineId,
      })),
      salePayments: pays.map((p) => ({
        saleId: p.saleId,
        method: p.method,
        amount: dec(p.amount),
        tendered: dec(p.tendered),
        change: dec(p.change),
      })),
      closings: closings.map((c) => ({
        id: c.id,
        kind: c.kind,
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
        closedAt: normInstant(c.closedAt),
        tickets: c.tickets,
        cancellations: c.cancellations,
        returns: c.returns,
        salesTotal: dec(c.salesTotal),
        refundsTotal: dec(c.refundsTotal),
        netTotal: dec(c.netTotal),
        grandTotal: dec(c.grandTotal),
        totals: c.totals,
        journalSeq: c.journalSeq,
      })),
      journal: journal.map((j) => ({
        seq: j.seq,
        at: normInstant(j.at),
        kind: j.kind,
        data: j.data,
        prevHash: j.prevHash,
        hash: j.hash,
        signature: j.signature,
      })),
      reprints: reprints.map((r) => ({
        id: r.id,
        saleId: r.saleId,
        copyNo: r.copyNo,
        at: normInstant(r.at),
        cashierId: r.cashierId,
      })),
    },
    { generatedAt: now.toISOString(), from, to },
    fiscalSealKey(),
  );
}
