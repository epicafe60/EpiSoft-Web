import { eq, sql } from 'drizzle-orm';
import { product, stockMovement, type DbOrTx } from '@episoft/db';
import { milliToDecimal } from '@episoft/shared';

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
  await tx.insert(stockMovement).values({
    productId: m.productId,
    at: m.at ?? new Date(),
    qty,
    kind: m.kind,
    unitCost: m.unitCost ?? null,
    sourceType: m.sourceType ?? null,
    sourceId: m.sourceId ?? null,
    comment: m.comment ?? null,
    by: m.by ?? null,
  });
  await tx
    .update(product)
    .set({
      stockQty: sql`${product.stockQty} + ${qty}::numeric`,
      updatedAt: sql`${product.updatedAt}`,
    })
    .where(eq(product.id, m.productId));
}
