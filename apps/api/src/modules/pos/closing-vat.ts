import { sql } from 'drizzle-orm';
import { type DbOrTx } from '@episoft/db';
import {
  decimalToCents,
  isLiable,
  regimeMention,
  vatBreakdownIncl,
  type VatBreakdown,
  type VatRegime,
} from '@episoft/shared';

export interface SessionVat {
  /** VAT included in the tickets of the LIABLE regime, by rate. */
  breakdown: VatBreakdown;
  /** Tickets recorded under another regime (franchise, exempt): total TTC and mention. */
  untaxed: { regime: VatRegime; inclCents: number; mention: string }[];
}

/**
 * R-TVA-05: the VAT included in the sales of a session, by rate (HT = round(sum TTC / (1 + rate)),
 * never per ticket), for the tickets recorded under the LIABLE regime. Tickets of the other
 * regimes carry no VAT: their total and their mention are reported apart. Donations are out of the
 * scope of VAT; cagnotte top-ups are not sales.
 */
export async function sessionVat(db: DbOrTx, sessionId: string): Promise<SessionVat> {
  const rows = await db.execute<{
    rate: string;
    regime: VatRegime;
    donation: boolean;
    cents: string;
  }>(sql`
    select l.vat_rate::text as rate, s.vat_regime::text as regime, p.code = '01004' as donation,
           coalesce(sum(l.line_total), 0)::text as cents
      from app.sale s
      join app.sale_line l on l.sale_id = s.id
      join app.product p on p.id = l.product_id
     where s.session_id = ${sessionId}
     group by 1, 2, 3`);
  const breakdown = vatBreakdownIncl(
    rows.rows
      .filter((r) => isLiable(r.regime))
      .map((r) => ({ rate: r.rate, inclCents: decimalToCents(r.cents), outOfScope: r.donation })),
  );
  const other = new Map<VatRegime, number>();
  for (const r of rows.rows)
    if (!isLiable(r.regime) && !r.donation)
      other.set(r.regime, (other.get(r.regime) ?? 0) + decimalToCents(r.cents));
  return {
    breakdown,
    untaxed: [...other.entries()].map(([regime, inclCents]) => ({
      regime,
      inclCents,
      mention: regimeMention(regime)!,
    })),
  };
}
