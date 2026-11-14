import { eq } from 'drizzle-orm';
import { memberPayment, walletEntry, type Tx } from '@episoft/db';
import { centsToDecimal, decimalToCents } from '@episoft/shared';
import { conflict, notFound } from '../../lib/problem';
import { lockedBalanceCents } from '../pos/wallet';

/**
 * R-CAG-08: cancels a top-up entered at the back office. The ledger of a cagnotte is history and
 * never loses a line (migration 0031, history_guard): the top-up stays, and an entry of the
 * opposite amount cancels it, with a payment of the opposite amount so that every payment still
 * has its entry (integrity check CAG-02). A top-up is cancelled once.
 * The caller checks who may do it and when (the same day, not a top-up made at the till).
 */
export async function cancelTopupEntry(
  tx: Tx,
  entryId: string,
  userId: string,
): Promise<{ householdId: string; amount: string; entry: unknown; payment: unknown }> {
  const [e] = await tx.select().from(walletEntry).where(eq(walletEntry.id, entryId)).for('update');
  if (!e) throw notFound('Opération introuvable.');
  if (e.kind !== 'TOPUP' || !e.paymentId || e.saleId)
    throw conflict('Seul un versement saisi au back-office peut être annulé.');
  const [pay] = await tx.select().from(memberPayment).where(eq(memberPayment.id, e.paymentId));
  if (!pay) throw conflict('Le paiement de ce versement est introuvable.');
  if (pay.cashSessionId) throw conflict('Un versement fait en caisse ne peut pas être annulé ici.');
  const [already] = await tx
    .select({ id: walletEntry.id })
    .from(walletEntry)
    .where(eq(walletEntry.cancelsEntryId, e.id));
  if (already) throw conflict('Ce versement est déjà annulé.');

  await lockedBalanceCents(tx, e.householdId);
  const opposite = centsToDecimal(-decimalToCents(e.amount));
  const [counter] = await tx
    .insert(memberPayment)
    .values({
      householdId: e.householdId,
      // Same day as the payment it cancels: the two add up to nothing in the reports of that day.
      date: pay.date,
      amount: opposite,
      purpose: 'TOPUP',
      method: pay.method,
      comment: 'Annulation d’un versement saisi par erreur',
      createdBy: userId,
    })
    .returning({ id: memberPayment.id });
  await tx.insert(walletEntry).values({
    householdId: e.householdId,
    amount: opposite,
    kind: 'CORRECTION',
    paymentMethod: e.paymentMethod,
    paymentId: counter!.id,
    cancelsEntryId: e.id,
    comment: 'Annulation du versement saisi par erreur',
    createdBy: userId,
  });
  return { householdId: e.householdId, amount: e.amount, entry: e, payment: pay };
}
