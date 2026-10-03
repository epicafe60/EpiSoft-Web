import { z } from 'zod';
import { lineTotalCents, milliToDecimal, parseQtyToMilli } from './pos';

// Customer pre-orders and the online cart (spec §4.14, R-PRE-01..03). Pure rules.

export const PREORDER_STATUSES = ['SUBMITTED', 'READY', 'PICKED_UP', 'CANCELLED'] as const;
export type PreorderStatus = (typeof PREORDER_STATUSES)[number];

export const PREORDER_STATUS_LABELS: Record<PreorderStatus, string> = {
  SUBMITTED: 'Reçue',
  READY: 'Prête',
  PICKED_UP: 'Retirée',
  CANCELLED: 'Annulée',
};

/** Statuses that still ask the shop for goods: they feed the supplier suggestion (R-PRE-02). */
export const OPEN_PREORDER_STATUSES = [
  'SUBMITTED',
  'READY',
] as const satisfies readonly PreorderStatus[];

const TRANSITIONS: Record<PreorderStatus, readonly PreorderStatus[]> = {
  SUBMITTED: ['READY', 'CANCELLED'],
  READY: ['SUBMITTED', 'PICKED_UP', 'CANCELLED'],
  PICKED_UP: [],
  CANCELLED: [],
};

export const canTransition = (from: PreorderStatus, to: PreorderStatus) =>
  TRANSITIONS[from].includes(to);

/** A member may cancel their own order until the shop has prepared it. */
export const memberCanCancel = (status: PreorderStatus) => status === 'SUBMITTED';

const qtyInput = z
  .string()
  .trim()
  .refine((s) => (parseQtyToMilli(s) ?? 0) > 0, 'Quantité invalide.')
  .transform((s) => milliToDecimal(parseQtyToMilli(s)!));

export const preorderSchema = z.object({
  /** Pick-up date; the API refuses a date in the past. */
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date de retrait invalide.'),
  comment: z.string().trim().max(300).optional(),
  /** For a volunteer keying in an order for a member. */
  memberId: z.string().uuid().optional(),
  lines: z
    .array(z.object({ productId: z.string().uuid(), qty: qtyInput }))
    .min(1, 'Le panier est vide.')
    .max(200),
});
export type PreorderInput = z.input<typeof preorderSchema>;

/** Merges repeated products of a cart into one line each (quantities add up). */
export function mergeCartLines<T extends { productId: string; qty: string }>(
  lines: readonly T[],
): T[] {
  const byProduct = new Map<string, T>();
  for (const l of lines) {
    const prev = byProduct.get(l.productId);
    byProduct.set(
      l.productId,
      prev
        ? {
            ...prev,
            qty: milliToDecimal((parseQtyToMilli(prev.qty) ?? 0) + (parseQtyToMilli(l.qty) ?? 0)),
          }
        : l,
    );
  }
  return [...byProduct.values()];
}

/** Cart total in cents, at the catalogue prices (information: the till charges the price of the day). */
export function cartTotalCents(lines: readonly { qty: string; unitPriceCents: number }[]): number {
  return lines.reduce(
    (s, l) =>
      s +
      lineTotalCents({
        qtyMilli: parseQtyToMilli(l.qty) ?? 0,
        unitPriceCents: l.unitPriceCents,
        discountCents: 0,
      }),
    0,
  );
}

/** R-PRE-01: the earliest pick-up date is today; a past date is refused. */
export const pickupDateValid = (pickupDate: string, today: string) => pickupDate >= today;
