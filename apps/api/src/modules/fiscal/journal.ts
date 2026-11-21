import { asc, eq, sql } from 'drizzle-orm';
import { fiscalJournal, sale, saleLine, salePayment, type DbOrTx } from '@episoft/db';
import {
  GENESIS_HASH,
  hmacSha256Hex,
  journalHash,
  normDecimal,
  normInstant,
} from '@episoft/shared';
import type { Config } from '../../config';
import { nextNumber } from '../pos/numbers';

// ADR 0016: the server's chained, signed journal. One entry per event of the till; the entry
// freezes the canonical fields of what happened, and the integrity check recomputes them.

let sealKey: string | null = null;

/** Called once when the application is built: the key the signatures are made with (may be absent). */
export function configureFiscal(config: Pick<Config, 'FISCAL_SEAL_KEY'>): void {
  sealKey = config.FISCAL_SEAL_KEY ?? null;
}
export const fiscalSealKey = () => sealKey;

/** Held shared while a ticket is recorded, exclusively while a day is closed. */
export const PERIOD_LOCK = 7_160_001;

export const SALE_KINDS = ['SALE', 'SALE_CANCEL', 'SALE_RETURN'] as const;
export type SaleJournalKind = (typeof SALE_KINDS)[number];

export interface JournalInput {
  kind: string;
  refType: 'sale' | 'session' | 'closing';
  refId: string;
  at: Date;
  data: unknown;
}

/**
 * Appends an entry. The row lock of the counter serializes writers until the transaction ends, so
 * `seq` has no gap and each entry follows the previous one; a rolled-back operation gives its rank back.
 */
export async function appendJournal(
  tx: DbOrTx,
  e: JournalInput,
): Promise<{ seq: number; hash: string }> {
  const seq = await nextNumber(tx, 'fiscal_journal');
  let prevHash = GENESIS_HASH;
  if (seq > 1) {
    const [prev] = await tx
      .select({ hash: fiscalJournal.hash })
      .from(fiscalJournal)
      .where(eq(fiscalJournal.seq, seq - 1));
    if (!prev) throw new Error(`journal fiscal : l’entrée ${seq - 1} manque`);
    prevHash = prev.hash;
  }
  const at = new Date(normInstant(e.at));
  const hash = await journalHash({
    seq,
    at: at.toISOString(),
    kind: e.kind,
    data: e.data,
    prevHash,
  });
  await tx.insert(fiscalJournal).values({
    seq,
    at,
    kind: e.kind,
    refType: e.refType,
    refId: e.refId,
    data: e.data as object,
    prevHash,
    hash,
    signature: sealKey ? await hmacSha256Hex(sealKey, hash) : null,
  });
  return { seq, hash };
}

/**
 * The canonical fields of a ticket, read from the rows themselves. What is not here (status,
 * warnings, e-mail date, discount total) is what the history guard lets the application change.
 */
export async function saleSealData(tx: DbOrTx, saleId: string): Promise<Record<string, unknown>> {
  const [s] = await tx.select().from(sale).where(eq(sale.id, saleId));
  if (!s) throw new Error('ticket introuvable');
  const lines = await tx
    .select()
    .from(saleLine)
    .where(eq(saleLine.saleId, saleId))
    .orderBy(asc(saleLine.lineNo));
  const pays = await tx.select().from(salePayment).where(eq(salePayment.saleId, saleId));
  const payments = pays
    .map((p) => ({
      m: p.method,
      a: normDecimal(p.amount),
      t: p.tendered == null ? null : normDecimal(p.tendered),
      c: p.change == null ? null : normDecimal(p.change),
      w: p.changeToWallet,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    id: s.id,
    number: s.number,
    no: s.provisionalNumber,
    device: s.deviceId,
    session: s.sessionId,
    at: normInstant(s.soldAt),
    day: s.accountingDay,
    cashier: s.cashierId,
    member: s.memberId,
    household: s.householdId,
    total: normDecimal(s.total),
    cancels: s.cancelsSaleId,
    returns: s.returnsSaleId,
    reason: s.returnReason,
    refund: s.refundMethod,
    seal: s.registerSeq == null ? null : { seq: s.registerSeq, hash: s.tillHash },
    lines: lines.map((l) => ({
      n: l.lineNo,
      p: l.productId,
      label: l.label,
      q: normDecimal(l.qty),
      u: normDecimal(l.unitPrice),
      c: l.catalogPrice == null ? null : normDecimal(l.catalogPrice),
      d: normDecimal(l.discount),
      t: normDecimal(l.lineTotal),
      v: normDecimal(l.vatRate),
      r: l.returnsLineId,
    })),
    payments,
  };
}

/** Seals a ticket that has just been written (the row, its lines and its payments exist). */
export async function sealSale(tx: DbOrTx, kind: SaleJournalKind, saleId: string, at: Date) {
  return appendJournal(tx, {
    kind,
    refType: 'sale',
    refId: saleId,
    at,
    data: await saleSealData(tx, saleId),
  });
}

/** Shared lock of the closings: taken before the accounting day of a ticket is decided. */
export async function lockPeriodShared(tx: DbOrTx) {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${PERIOD_LOCK})`);
}
export async function lockPeriodExclusive(tx: DbOrTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${PERIOD_LOCK})`);
}
