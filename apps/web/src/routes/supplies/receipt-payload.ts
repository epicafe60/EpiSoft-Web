import { parsePrice4, parseQtyToMilli } from '@episoft/shared';

// What the reception screen sends. Pure, so it is tested without the screen.

export interface ReceiveFormLine {
  orderLineId: string | null;
  productId: string;
  qty: string;
  unitPriceExcl: string;
  bestBefore: string;
  /** Supplier lot number (compulsory for food). */
  lotNumber: string;
  newSalePrice: string;
  /** « Mettre à jour la fiche produit »: unchecked by default, never implied. */
  updateProductPrice: boolean;
}

/**
 * Only the lines with a quantity are received. `updateProductPrice` is sent on every line, true
 * only when the person ticked it: otherwise the server never touches the product sheet.
 */
export function receiptPayload(lines: ReceiveFormLine[], date: string, closeOrder: boolean) {
  const received = lines.filter((l) => (parseQtyToMilli(l.qty || '0') ?? 0) > 0);
  return {
    date,
    closeOrder,
    lines: received.map((l) => ({
      orderLineId: l.orderLineId,
      productId: l.productId,
      qty: l.qty,
      unitPriceExcl: l.unitPriceExcl,
      bestBefore: l.bestBefore || null,
      lotNumber: l.lotNumber.trim() || null,
      updateProductPrice: l.updateProductPrice === true,
    })),
    newSalePrices: Object.fromEntries(
      received.filter((l) => l.newSalePrice).map((l) => [l.productId, l.newSalePrice]),
    ),
  };
}

/** The gap between a reference price and the received one: amount (4 decimals) and percent. */
export function priceGap(
  reference: string | null,
  received: string,
): { amount4: number; pct: number | null } | null {
  const next = parsePrice4(received || '0');
  if (next === null) return null;
  const ref = reference === null ? null : parsePrice4(reference);
  if (ref === null) return null;
  if (next === ref) return { amount4: 0, pct: 0 };
  return {
    amount4: next - ref,
    pct: ref === 0 ? null : Math.round(((next - ref) / ref) * 1000) / 10,
  };
}
