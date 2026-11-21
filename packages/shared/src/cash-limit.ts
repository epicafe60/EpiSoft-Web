import { centsToDecimal } from './money';

/**
 * Legal cap of a payment in cash (art. L112-6 and D112-3 of the Code monétaire et financier): 1 000 €
 * for a debtor resident in France (a supplier invoice paid by the association, a sale at the till
 * to a consumer), 15 000 € for a non-resident. Above it, the payment goes through a bank
 * instrument: the till and the back office refuse it, they do not warn.
 * Shared by the back office (supplier payments) and the till.
 */
export const CASH_PAYMENT_LIMIT_CENTS = 100_000;
export const CASH_PAYMENT_LIMIT_NON_RESIDENT_CENTS = 1_500_000;
export const CASH_PAYMENT_LIMIT_REFERENCE = 'art. D112-3 du code monétaire et financier';

/** Null when the cash payment is allowed, else the French refusal. */
export function cashPaymentProblem(
  cashCents: number,
  opts: { resident?: boolean } = {},
): string | null {
  const limit =
    opts.resident === false ? CASH_PAYMENT_LIMIT_NON_RESIDENT_CENTS : CASH_PAYMENT_LIMIT_CENTS;
  if (cashCents <= limit) return null;
  return `Un paiement en espèces ne peut dépasser ${centsToDecimal(limit)} € (${CASH_PAYMENT_LIMIT_REFERENCE}) : réglez le surplus par un autre moyen.`;
}
