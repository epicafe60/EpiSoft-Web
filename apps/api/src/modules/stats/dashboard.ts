import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '@episoft/db';
import {
  PERIOD_KEYS,
  averageBasketCents,
  hasAnyRole,
  periodRange,
  variationPercent,
  type DateRange,
} from '@episoft/shared';
import type { Config } from '../../config';
import { toParisDate } from '../../lib/dates';

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

/** Net sales (cancellations carry negative totals) over a Paris date range. */
async function salesFigures(db: Db, r: DateRange) {
  const res = await db.execute(sql`
    select coalesce(sum(total) * 100, 0)::bigint as cents,
           count(*) filter (where cancels_sale_id is null and status = 'COMPLETED')::int as tickets
    from app.sale
    where (sold_at at time zone 'Europe/Paris')::date between ${r.from}::date and ${r.to}::date`);
  const row = res.rows[0] as Row;
  return { cents: num(row.cents), tickets: num(row.tickets) };
}

/** R-STA-02 — the figures of the home page, each block only for the roles that use it. */
export const dashboardRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  app.get('/stats/dashboard', async (req) => {
    const roles = req.user!.roles;
    const today = toParisDate(new Date());
    const can = (...r: Parameters<typeof hasAnyRole>[1]) => hasAnyRole(roles, r);
    const out: Record<string, unknown> = { today };

    if (can('STATS', 'CAISSE')) {
      out.sales = await Promise.all(
        PERIOD_KEYS.map(async (key) => {
          const { current, previous } = periodRange(key, today);
          const [cur, prev] = await Promise.all([
            salesFigures(db, current),
            salesFigures(db, previous),
          ]);
          return {
            key,
            current,
            cents: cur.cents,
            previousCents: prev.cents,
            variationPercent: variationPercent(cur.cents, prev.cents),
            tickets: cur.tickets,
            averageBasketCents: averageBasketCents(cur.cents, cur.tickets),
          };
        }),
      );
      const month = periodRange('month', today).current;
      const pay = await db.execute(sql`
        select p.method, (sum(p.amount) * 100)::bigint as cents
        from app.sale_payment p join app.sale s on s.id = p.sale_id
        where (s.sold_at at time zone 'Europe/Paris')::date between ${month.from}::date and ${month.to}::date
        group by p.method order by 2 desc`);
      out.payments = pay.rows.map((r) => ({
        method: String((r as Row).method),
        cents: num((r as Row).cents),
      }));
      const top = await db.execute(sql`
        select l.product_id, max(l.label) as label, sum(l.qty)::text as qty, (sum(l.line_total) * 100)::bigint as cents
        from app.sale_line l join app.sale s on s.id = l.sale_id
        where (s.sold_at at time zone 'Europe/Paris')::date between ${month.from}::date and ${month.to}::date
        group by l.product_id order by 4 desc limit 10`);
      out.topProducts = top.rows.map((r) => ({
        productId: String((r as Row).product_id),
        label: String((r as Row).label),
        qty: String((r as Row).qty),
        cents: num((r as Row).cents),
      }));
    }

    if (can('STATS', 'PRODUITS', 'APPROS')) {
      const low = await db.execute(sql`
        select id, code, name, stock_qty::text as stock, min_stock::text as min
        from app.product
        where status = 'ACTIVE' and min_stock is not null and stock_qty < min_stock
        order by (stock_qty - min_stock) limit 20`);
      out.lowStock = low.rows.map((r) => ({
        id: String((r as Row).id),
        code: String((r as Row).code),
        name: String((r as Row).name),
        stock: String((r as Row).stock),
        min: String((r as Row).min),
      }));
      const labels = await db.execute(
        sql`select count(*)::int as n from app.product where label_pending and status = 'ACTIVE'`,
      );
      out.labelsToPrint = num((labels.rows[0] as Row).n);
    }

    if (can('STATS', 'APPROS', 'COMPTA')) {
      const due = await db.execute(sql`
        select i.id, s.name as supplier, i.piece_ref, i.due_date::text as due_date, (i.total_incl * 100)::bigint as cents
        from app.supplier_invoice i join app.supplier s on s.id = i.supplier_id
        where i.status = 'TO_PAY' and i.due_date <= (${today}::date + 7)
        order by i.due_date limit 20`);
      out.invoicesDue = due.rows.map((r) => ({
        id: String((r as Row).id),
        supplier: String((r as Row).supplier),
        pieceRef: String((r as Row).piece_ref),
        dueDate: String((r as Row).due_date),
        cents: num((r as Row).cents),
        late: String((r as Row).due_date) < today,
      }));
    }

    if (can('STATS', 'ADHERENTS')) {
      // Households whose latest membership ends within 30 days (and is not already over).
      const exp = await db.execute(sql`
        select h.id as household_id, h.number, coalesce(m.last_name || ' ' || m.first_name, '—') as name,
               last.end_date::text as end_date
        from (select household_id, max(end_date) as end_date from app.membership
              where cancelled_at is null group by household_id) last
        join app.household h on h.id = last.household_id
        left join app.member m on m.id = h.referent_member_id
        where last.end_date between ${today}::date and (${today}::date + 30)
        order by last.end_date limit 20`);
      out.membershipsExpiring = exp.rows.map((r) => ({
        householdId: String((r as Row).household_id),
        number: num((r as Row).number),
        name: String((r as Row).name),
        endDate: String((r as Row).end_date),
      }));
    }
    return out;
  });
};
