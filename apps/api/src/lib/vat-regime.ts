import { asc } from 'drizzle-orm';
import { vatRegimeChange, type DbOrTx } from '@episoft/db';
import { regimeAt, type VatRegime, type VatRegimeChange } from '@episoft/shared';

/** R-TVA-07: the history of the VAT regime, oldest first. Empty means LIABLE. */
export async function loadRegimeChanges(db: DbOrTx): Promise<VatRegimeChange[]> {
  const rows = await db.select().from(vatRegimeChange).orderBy(asc(vatRegimeChange.effectiveFrom));
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, regime: r.regime }));
}

/** The regime in force on a shop date. A ticket or an invoice stores it when it is recorded. */
export async function regimeOn(db: DbOrTx, date: string): Promise<VatRegime> {
  return regimeAt(await loadRegimeChanges(db), date);
}
