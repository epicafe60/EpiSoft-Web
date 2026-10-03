import { sql } from 'drizzle-orm';
import { numberCounter, type DbOrTx } from '@episoft/db';
import { formatSaleNumber } from '@episoft/shared';
import { parisYear } from '../../lib/dates';

/**
 * Next value of a gapless counter. The row lock serializes concurrent sales, and a
 * rolled-back transaction gives its number back (continuous numbering, §5.7).
 */
export async function nextNumber(tx: DbOrTx, key: string): Promise<number> {
  const [row] = await tx
    .insert(numberCounter)
    .values({ key, value: 1 })
    .onConflictDoUpdate({
      target: numberCounter.key,
      set: { value: sql`${numberCounter.value} + 1` },
    })
    .returning({ value: numberCounter.value });
  return row!.value;
}

/** R-VTE-10: T-AAAA-NNNNNN, numbered per calendar year (Paris time). */
export async function nextSaleNumber(tx: DbOrTx, soldAt: Date): Promise<string> {
  const year = parisYear(soldAt);
  return formatSaleNumber(year, await nextNumber(tx, `sale:${year}`));
}
