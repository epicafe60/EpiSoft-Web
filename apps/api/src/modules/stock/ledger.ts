import { eq, sql } from 'drizzle-orm';
import { product, stockMovement, type DbOrTx } from '@episoft/db';
import {
  decimalToMicro,
  microToDecimal,
  milliToDecimal,
  nextAverage,
  parseQtyToMilli,
  PRICED_MOVEMENT_KINDS,
} from '@episoft/shared';

export type MovementKind = (typeof stockMovement.$inferInsert)['kind'];

export interface Movement {
  productId: string;
  /** Signed, in thousandths. */
  qtyMilli: number;
  kind: MovementKind;
  unitCost?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  comment?: string | null;
  by?: string | null;
  at?: Date;
}

/**
 * R-STK-01/02: every stock change is a movement; the cached stock of the product is
 * updated in the same transaction. updated_at is left alone so the till snapshot is not
 * refreshed for every sale.
 */
export async function recordMovement(tx: DbOrTx, m: Movement): Promise<void> {
  if (m.qtyMilli === 0) return;
  const qty = milliToDecimal(m.qtyMilli);
  // The product row is locked: two movements of one product at once see each other's average.
  const [p] = await tx
    .select({ stockQty: product.stockQty, avgCost: product.avgCost })
    .from(product)
    .where(eq(product.id, m.productId))
    .for('update');
  // R-STK-06: weighted average cost (CMUP). A purchase or an opening stock enters at its cost;
  // everything else (sales, losses, inventory, returns) is valued at the current average.
  const avg = p
    ? nextAverage(
        { qtyMilli: parseQtyToMilli(p.stockQty) ?? 0, avgMicro: decimalToMicro(p.avgCost) },
        {
          qtyMilli: m.qtyMilli,
          unitCostMicro: decimalToMicro(m.unitCost),
          priced: (PRICED_MOVEMENT_KINDS as readonly string[]).includes(m.kind),
        },
      )
    : null;
  const avgText = avg === null ? null : microToDecimal(avg);
  await tx.insert(stockMovement).values({
    productId: m.productId,
    at: m.at ?? new Date(),
    qty,
    kind: m.kind,
    unitCost: m.unitCost ?? null,
    avgCostAfter: avgText,
    sourceType: m.sourceType ?? null,
    sourceId: m.sourceId ?? null,
    comment: m.comment ?? null,
    by: m.by ?? null,
  });
  await tx
    .update(product)
    .set({
      stockQty: sql`${product.stockQty} + ${qty}::numeric`,
      avgCost: avgText,
      updatedAt: sql`${product.updatedAt}`,
    })
    .where(eq(product.id, m.productId));
}
