import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  account,
  bankLine,
  entry,
  entryLine,
  supplierCreditAllocation,
  supplierCreditNote,
  supplierInvoice,
  type Tx,
} from '@episoft/db';
import { toShopDate } from '../../lib/dates';
import { conflict, notFound } from '../../lib/problem';
import { nextLetteringCode } from './auto';
import { reverseEntry } from './service';

/** True when a line of the entry is reconciled with a bank statement or a bank line. */
async function isReconciled(tx: Tx, entryId: string): Promise<boolean> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(entryLine)
    .where(and(eq(entryLine.entryId, entryId), isNotNull(entryLine.reconciliationId)));
  if (r!.n > 0) return true;
  const [b] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bankLine)
    .innerJoin(entryLine, eq(entryLine.id, bankLine.entryLineId))
    .where(eq(entryLine.entryId, entryId));
  return (b?.n ?? 0) > 0;
}

/** Letters the supplier (401) lines of the given entries together, so the pair is settled. */
async function letterSupplierLines(tx: Tx, entryIds: (string | null)[], date: string) {
  const ids = entryIds.filter((i): i is string => !!i);
  if (ids.length < 2) return;
  const code = await nextLetteringCode(tx);
  const lines = await tx
    .select({ id: entryLine.id })
    .from(entryLine)
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(
      and(
        sql`${account.number} like '401%'`,
        sql`${entryLine.entryId} in (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})`,
      ),
    );
  for (const l of lines)
    await tx
      .update(entryLine)
      .set({ letteringCode: code, letteredOn: date })
      .where(eq(entryLine.id, l.id));
}

/**
 * Takes an entry out of the books: a draft was never part of them and is deleted; a validated
 * one is inalterable (R-CPT-05, art. L123-12 du Code de commerce) and gets a counter entry.
 * Returns the counter entry id, null for a draft.
 */
export async function withdrawEntry(
  tx: Tx,
  entryId: string,
  opts: { date?: string; label: string; userId: string; source: { type: string; id: string } },
): Promise<string | null> {
  const [e] = await tx.select().from(entry).where(eq(entry.id, entryId)).for('update');
  if (!e) return null;
  if (e.status === 'DRAFT') {
    await tx.delete(entryLine).where(eq(entryLine.entryId, e.id));
    await tx.delete(entry).where(eq(entry.id, e.id));
    return null;
  }
  return reverseEntry(tx, e.id, {
    date: opts.date,
    label: opts.label,
    userId: opts.userId,
    source: opts.source,
  });
}

/** Removes the lettering of every line that shares the code of the given entries. */
async function unletter(tx: Tx, entryIds: (string | null)[]) {
  const ids = entryIds.filter((i): i is string => !!i);
  if (!ids.length) return;
  const codes = await tx
    .selectDistinct({ code: entryLine.letteringCode })
    .from(entryLine)
    .where(
      and(
        isNotNull(entryLine.letteringCode),
        sql`${entryLine.entryId} in (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})`,
      ),
    );
  for (const c of codes)
    await tx
      .update(entryLine)
      .set({ letteringCode: null, letteredOn: null })
      .where(eq(entryLine.letteringCode, c.code!));
}

/**
 * Reverses the payment of an invoice with a counter entry (motif required, audited): the invoice
 * goes back to « à régler ». Refused when the payment is reconciled with the bank.
 */
export async function reverseInvoicePayment(
  tx: Tx,
  a: { invoiceId: string; reason: string; date?: string; userId: string },
) {
  const [inv] = await tx
    .select()
    .from(supplierInvoice)
    .where(eq(supplierInvoice.id, a.invoiceId))
    .for('update');
  if (!inv) throw notFound('Facture introuvable.');
  if (inv.status !== 'PAID') throw conflict('Cette facture n’est pas réglée.');
  if (inv.paymentEntryId && (await isReconciled(tx, inv.paymentEntryId)))
    throw conflict(
      'Ce règlement est rapproché d’un relevé bancaire : défaites le rapprochement avant de l’annuler.',
    );
  const date = a.date ?? toShopDate(new Date());
  let counterEntryId: string | null = null;
  if (inv.paymentEntryId) {
    await unletter(tx, [inv.entryId, inv.paymentEntryId]);
    counterEntryId = await withdrawEntry(tx, inv.paymentEntryId, {
      date,
      label: `Annulation du règlement de la facture ${inv.pieceRef} (${a.reason})`,
      userId: a.userId,
      source: { type: 'invoice_payment_reversal', id: `${inv.id}:${Date.now()}` },
    });
    // The payment and its counter entry cancel each other: they are lettered together.
    await letterSupplierLines(tx, [inv.paymentEntryId, counterEntryId], date);
  } else {
    await unletter(tx, [inv.entryId]);
  }
  await tx
    .update(supplierInvoice)
    .set({ status: 'TO_PAY', paidAt: null, paymentEntryId: null })
    .where(eq(supplierInvoice.id, inv.id));
  return { counterEntryId, invoice: inv };
}

/**
 * Cancels an invoice entered by mistake (motif required, audited). It is never deleted: its
 * entry gets a counter entry and its status becomes CANCELLED. A paid invoice has its payment
 * reversed first. Refused while credit notes refer to it.
 */
export async function cancelInvoice(
  tx: Tx,
  a: { invoiceId: string; reason: string; userId: string },
) {
  const [inv] = await tx
    .select()
    .from(supplierInvoice)
    .where(eq(supplierInvoice.id, a.invoiceId))
    .for('update');
  if (!inv) throw notFound('Facture introuvable.');
  if (inv.status === 'CANCELLED') throw conflict('Cette facture est déjà annulée.');
  const [linked] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(supplierCreditNote)
    .where(and(eq(supplierCreditNote.invoiceId, inv.id), eq(supplierCreditNote.status, 'ACTIVE')));
  if (linked!.n > 0)
    throw conflict('Des avoirs se rapportent à cette facture : annulez-les d’abord.');
  const [allocated] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(supplierCreditAllocation)
    .where(eq(supplierCreditAllocation.invoiceId, inv.id));
  if (allocated!.n > 0)
    throw conflict('Des avoirs sont imputés sur cette facture : retirez les imputations d’abord.');
  let paymentCounterEntryId: string | null = null;
  if (inv.status === 'PAID')
    paymentCounterEntryId = (
      await reverseInvoicePayment(tx, {
        invoiceId: inv.id,
        reason: `annulation de la facture : ${a.reason}`,
        userId: a.userId,
      })
    ).counterEntryId;
  let cancelEntryId: string | null = null;
  if (inv.entryId) {
    await unletter(tx, [inv.entryId]);
    cancelEntryId = await withdrawEntry(tx, inv.entryId, {
      label: `Annulation de la facture ${inv.pieceRef} (${a.reason})`,
      userId: a.userId,
      source: { type: 'invoice_cancel', id: inv.id },
    });
    await letterSupplierLines(tx, [inv.entryId, cancelEntryId], toShopDate(new Date()));
  }
  await tx
    .update(supplierInvoice)
    .set({
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: a.userId,
      cancelReason: a.reason,
      cancelEntryId,
    })
    .where(eq(supplierInvoice.id, inv.id));
  return { cancelEntryId, paymentCounterEntryId, invoice: inv };
}
