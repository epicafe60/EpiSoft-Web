import { sql } from 'drizzle-orm';
import type { Tx } from '../index';
import * as s from '../schema';
import { importOptions } from './options';

/**
 * The regime of the imported history is also the regime in force of the association: without a
 * history of regimes the application would apply « assujetti » to the next ticket. When the
 * history is empty (nobody chose a regime yet), the chosen one takes effect from the first day
 * of the data taken over. A regime already recorded in the administration is never touched.
 */
export async function ensureRegimeHistory(tx: Tx): Promise<void> {
  if (importOptions.vatRegime === 'LIABLE') return; // the default of the application
  const existing = (await tx.execute(sql`select count(*)::int as n from app.vat_regime_change`))
    .rows[0] as { n: number } | undefined;
  if (existing && existing.n > 0) return;
  const first = (
    await tx.execute(sql`select least(
        (select min((sold_at at time zone 'Europe/Paris')::date) from app.sale),
        (select min(date) from app.supplier_invoice),
        (select min(date) from app.member_payment))::text as d`)
  ).rows[0] as { d: string | null } | undefined;
  if (!first?.d) return;
  await tx
    .insert(s.vatRegimeChange)
    .values({ effectiveFrom: first.d, regime: importOptions.vatRegime });
}
