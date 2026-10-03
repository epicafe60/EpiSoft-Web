import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@episoft/db';
import { centsToDecimal, parsePrice4, parseQtyToMilli, stockValueCents } from '@episoft/shared';

const milli = (v: string | null | undefined) =>
  v === null || v === undefined ? 0 : (parseQtyToMilli(v) ?? 0);

/** R-STK-06: stock value at a date, at the purchase price HT or TTC of that date. */
export async function stockValuation(db: Db | Tx, date: string, basis: 'excl' | 'incl') {
  const res = await db.execute<{
    id: string;
    code: string;
    name: string;
    qty: string;
    price: string | null;
    category: string | null;
  }>(sql`
    select p.id, p.code, p.name, c.name as category,
           coalesce((select sum(m.qty) from app.stock_movement m where m.product_id = p.id and m.at < (${date}::date + 1)::timestamp at time zone 'Europe/Paris'), 0)::text as qty,
           coalesce(
             (select ${basis === 'excl' ? sql`h.purchase_price_excl` : sql`h.purchase_price_incl`} from app.price_history h
               where h.product_id = p.id and h.at < (${date}::date + 1)::timestamp at time zone 'Europe/Paris'
               order by h.at desc limit 1),
             ${basis === 'excl' ? sql`p.purchase_price_excl` : sql`p.purchase_price_incl`})::text as price
      from app.product p left join app.category c on c.id = p.category_id
     where p.kind = 'GOODS'
     order by p.code`);
  const rows = res.rows.map((r) => {
    const q = milli(r.qty);
    return { ...r, value: centsToDecimal(stockValueCents(q, parsePrice4(r.price))) };
  });
  const total = rows.reduce((s, r) => s + Math.round(Number(r.value) * 100), 0);
  return {
    date,
    basis,
    total: centsToDecimal(total),
    rows: rows.filter((r) => milli(r.qty) !== 0),
  };
}
