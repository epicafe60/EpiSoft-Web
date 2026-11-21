/**
 * Legal cap of a payment in cash (art. L112-6 and D112-3 of the Code monétaire et financier):
 * 1 000 € for a debtor resident in France (a supplier invoice paid by the association, a sale at
 * the till to a professional). Above it, the payment goes through a bank instrument.
 * Shared by the back office (supplier payments) and the till.
 */
export const CASH_PAYMENT_LIMIT_CENTS = 100_000;

export const CASH_PAYMENT_LIMIT_REFERENCE = 'art. L112-6 et D112-3 du Code monétaire et financier';

/** Null when the cash payment is allowed, else the French refusal. */
export function cashPaymentProblem(cents: number): string | null {
  if (cents <= CASH_PAYMENT_LIMIT_CENTS) return null;
  return `Un paiement en espèces ne peut pas dépasser ${CASH_PAYMENT_LIMIT_CENTS / 100} € (${CASH_PAYMENT_LIMIT_REFERENCE}) : réglez par virement, chèque ou prélèvement.`;
}
