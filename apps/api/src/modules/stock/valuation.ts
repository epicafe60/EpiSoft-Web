import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@episoft/db';
import {
  centsToDecimal,
  decimalToMicro,
  parseQtyToMilli,
  valueAtAverageCents,
} from '@episoft/shared';
import { tzSql } from '../../lib/dates';

const milli = (v: string | null | undefined) =>
  v === null || v === undefined ? 0 : (parseQtyToMilli(v) ?? 0);

export const VALUATION_METHOD = 'CMUP';
export const VALUATION_METHOD_LABEL = 'Coût moyen unitaire pondéré (CMUP)';

/**
 * R-STK-06: stock value at a date at the weighted average cost (CMUP, PCG art. 213-32). The
 * quantity is the sum of the movements up to the date; the average is the one the product had
 * after its last movement of that date (kept by the stock ledger). It no longer depends on the
 * purchase price of the product or on its price history: editing a price changes nothing here.
 * A product with no known cost yet (no priced entry) falls back to its current purchase price.
 * The TTC basis applies the product's VAT rate to the average cost excl. VAT.
 */
export async function stockValuation(db: Db | Tx, date: string, basis: 'excl' | 'incl') {
  const res = await db.execute<{
    id: string;
    code: string;
    name: string;
    qty: string;
    avg: string | null;
    fallback: string | null;
    vat_rate: string;
    category: string | null;
  }>(sql`
    select p.id, p.code, p.name, c.name as category, p.vat_rate::text as vat_rate,
           coalesce((select sum(m.qty) from app.stock_movement m where m.product_id = p.id and m.at < (${date}::date + 1)::timestamp at time zone ${tzSql()}), 0)::text as qty,
           (select m.avg_cost_after from app.stock_movement m
             where m.product_id = p.id and m.avg_cost_after is not null
               and m.at < (${date}::date + 1)::timestamp at time zone ${tzSql()}
             order by m.at desc, m.id desc limit 1)::text as avg,
           p.purchase_price_excl::text as fallback
      from app.product p left join app.category c on c.id = p.category_id
     where p.kind = 'GOODS'
     order by p.code`);
  const rows = res.rows.map((r) => {
    const q = milli(r.qty);
    const known = decimalToMicro(r.avg);
    const excl = known ?? decimalToMicro(r.fallback);
    const unit =
      excl === null
        ? null
        : basis === 'excl'
          ? excl
          : Math.round(excl * (1 + Number(r.vat_rate) / 100));
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      category: r.category,
      qty: r.qty,
      /** Average unit cost used (4 decimals, as on the other price columns). */
      price: unit === null ? null : (unit / 1_000_000).toFixed(4),
      /** CMUP when the ledger knows a cost, else the current purchase price. */
      costSource:
        known !== null ? ('CMUP' as const) : excl !== null ? ('PURCHASE_PRICE' as const) : null,
      value: centsToDecimal(q <= 0 ? 0 : valueAtAverageCents(q, unit)),
    };
  });
  const total = rows.reduce((s, r) => s + Math.round(Number(r.value) * 100), 0);
  return {
    date,
    basis,
    method: VALUATION_METHOD,
    methodLabel: VALUATION_METHOD_LABEL,
    total: centsToDecimal(total),
    rows: rows.filter((r) => milli(r.qty) !== 0),
  };
}
