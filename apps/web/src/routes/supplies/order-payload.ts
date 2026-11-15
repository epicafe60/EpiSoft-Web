import { parsePrice4, parseQtyToMilli } from '@episoft/shared';

// What the order editor sends. Pure, so it is tested without the screen.

export interface OrderFormLine {
  productId: string;
  name: string;
  qty: string;
  unitPriceExcl: string;
}

/**
 * R-CMD-02: a line left empty or at 0 is not recorded. A line with a quantity needs a valid
 * « PA HT unitaire » (it is carried over to the product sheet): an empty or invalid one is refused.
 */
export function orderLinesPayload(lines: OrderFormLine[]):
  | { ok: true; lines: { productId: string; qty: string; unitPriceExcl: string }[] }
  | {
      ok: false;
      error: string;
    } {
  const kept: { productId: string; qty: string; unitPriceExcl: string }[] = [];
  for (const l of lines) {
    const qty = l.qty.trim() === '' ? 0 : parseQtyToMilli(l.qty);
    if (qty === null) return { ok: false, error: `${l.name} : quantité invalide.` };
    if (qty <= 0) continue;
    const price = l.unitPriceExcl.trim() === '' ? null : parsePrice4(l.unitPriceExcl);
    if (price === null || price < 0)
      return {
        ok: false,
        error: `${l.name} : le PA HT unitaire est vide ou invalide (4 décimales au plus).`,
      };
    kept.push({ productId: l.productId, qty: l.qty, unitPriceExcl: l.unitPriceExcl });
  }
  return { ok: true, lines: kept };
}
