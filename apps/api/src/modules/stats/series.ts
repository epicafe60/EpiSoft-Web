import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '@episoft/db';
import { PAYMENT_METHOD_LABELS, suggestOrderQtyMilli, type PaymentMethod } from '@episoft/shared';
import type { Config } from '../../config';
import { reportXlsx, type ReportTable } from '../../lib/report-output';

type Row = Record<string, unknown>;

const GRANULARITIES = ['day', 'week', 'month'] as const;
type Granularity = (typeof GRANULARITIES)[number];

/** Period label of a timestamp column, in Paris time. */
const bucket = (g: Granularity, col: string): SQL => {
  const local = sql.raw(`(${col} at time zone 'Europe/Paris')`);
  return g === 'day'
    ? sql`to_char(${local}, 'YYYY-MM-DD')`
    : g === 'week'
      ? sql`to_char(${local}, 'IYYY-"S"IW')`
      : sql`to_char(${local}, 'YYYY-MM')`;
};

const period = z.object({
  from: z.string().date(),
  to: z.string().date(),
  granularity: z.enum(GRANULARITIES).default('month'),
});
const reportQuery = period.extend({
  format: z.enum(['json', 'xlsx']).default('json'),
  supplierId: z.string().uuid().optional(),
});

export const REPORT_KINDS = [
  'payments',
  'purchases',
  'movements',
  'households',
  'dormant',
  'hours',
  'losses',
  'forecast',
  'suggest',
  'cashgap',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const cents = (v: unknown) => Math.round(Number(v ?? 0));
const eur = (c: number) => (c / 100).toFixed(2);

const MOVEMENT_LABELS: Record<string, string> = {
  SALE: 'Vente',
  SALE_CANCEL: 'Annulation de vente',
  PURCHASE_IN: 'Entrée (achat)',
  SUPPLIER_RETURN: 'Retour fournisseur',
  INVENTORY: 'Inventaire',
  LOSS: 'Perte / casse',
  CORRECTION: 'Correction',
  INITIAL: 'Stock initial',
};

/** R-STA-03 — trends, payments by period, purchases, stock movements, sales per household. */
export const seriesRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const stats = { preHandler: app.requireRoles('STATS') };
  const inRange = (col: string, from: string, to: string) =>
    sql`(${sql.raw(col)} at time zone 'Europe/Paris')::date between ${from}::date and ${to}::date`;

  async function salesSeries(from: string, to: string, g: Granularity) {
    const res = await db.execute(sql`
      select ${bucket(g, 's.sold_at')} as period,
             round(sum(s.total) * 100)::bigint as cents,
             count(*) filter (where s.cancels_sale_id is null and s.status = 'COMPLETED')::int as tickets
      from app.sale s where ${inRange('s.sold_at', from, to)}
      group by 1 order by 1`);
    return (res.rows as Row[]).map((r) => ({
      period: String(r.period),
      cents: cents(r.cents),
      tickets: Number(r.tickets),
    }));
  }

  const shiftYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;

  /** Sales per bucket next to the same period one year earlier (N-1), matched by month/week/day. */
  app.get('/stats/trend', { ...stats, schema: { querystring: period } }, async (req) => {
    const { from, to, granularity } = req.query;
    const [current, previous] = await Promise.all([
      salesSeries(from, to, granularity),
      salesSeries(shiftYear(from), shiftYear(to), granularity),
    ]);
    const key = (p: string) => (granularity === 'week' ? p.slice(5) : p.slice(4));
    const prevBy = new Map(previous.map((p) => [key(p.period), p]));
    return {
      points: current.map((c) => {
        const p = prevBy.get(key(c.period));
        return { ...c, previousCents: p?.cents ?? 0, previousTickets: p?.tickets ?? 0 };
      }),
    };
  });

  async function build(kind: ReportKind, q: z.infer<typeof reportQuery>): Promise<ReportTable> {
    const { from, to, granularity: g } = q;
    const subtitle = `Du ${from} au ${to}`;
    if (kind === 'payments') {
      const res = await db.execute(sql`
        select ${bucket(g, 's.sold_at')} as period, p.method, round(sum(p.amount) * 100)::bigint as cents
        from app.sale_payment p join app.sale s on s.id = p.sale_id
        where ${inRange('s.sold_at', from, to)} group by 1, 2 order by 1, 2`);
      const rows = res.rows as Row[];
      const methods = [...new Set(rows.map((r) => String(r.method)))];
      const periods = [...new Set(rows.map((r) => String(r.period)))];
      return {
        title: 'Ventes par mode de paiement',
        subtitle,
        columns: [
          { key: 'period', label: 'Période', type: 'text' },
          ...methods.map((m) => ({
            key: m,
            label: PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m,
            type: 'money' as const,
          })),
          { key: 'total', label: 'Total', type: 'money' as const },
        ],
        rows: periods.map((p) => {
          const mine = rows.filter((r) => r.period === p);
          const cells: Record<string, string | null> = { period: p };
          let total = 0;
          for (const m of methods) {
            const c = cents(mine.find((r) => r.method === m)?.cents);
            total += c;
            cells[m] = eur(c);
          }
          cells.total = eur(total);
          return { cells };
        }),
      };
    }
    if (kind === 'purchases') {
      const sup = q.supplierId ? sql`and r.supplier_id = ${q.supplierId}::uuid` : sql``;
      const res = await db.execute(sql`
        select sp.name as supplier, ${bucket(g, 'r.date::timestamp')} as period,
               sum(l.qty)::text as qty, round(sum(l.qty * l.unit_price_excl) * 100)::bigint as cents
        from app.goods_receipt_line l
          join app.goods_receipt r on r.id = l.receipt_id
          join app.supplier sp on sp.id = r.supplier_id
        where r.date between ${from}::date and ${to}::date ${sup}
        group by 1, 2 order by 1, 2`);
      const data = res.rows as Row[];
      return {
        title: 'Achats (réceptions)',
        subtitle,
        columns: [
          { key: 'supplier', label: 'Fournisseur', type: 'text', width: 2 },
          { key: 'period', label: 'Période', type: 'text' },
          { key: 'qty', label: 'Quantité', type: 'text' },
          { key: 'amount', label: 'Montant HT', type: 'money' },
        ],
        rows: [
          ...data.map((r) => ({
            cells: {
              supplier: String(r.supplier),
              period: String(r.period),
              qty: String(r.qty),
              amount: eur(cents(r.cents)),
            },
          })),
          {
            bold: true,
            cells: {
              supplier: 'Total',
              period: '',
              qty: '',
              amount: eur(data.reduce((s, r) => s + cents(r.cents), 0)),
            },
          },
        ],
      };
    }
    if (kind === 'dormant') {
      // Stock tied up: products in stock that did not sell at all over the period.
      const res = await db.execute(sql`
        select p.code, p.name, p.stock_qty::text as qty,
               round(p.stock_qty * coalesce(p.purchase_price_excl, 0) * 100)::bigint as cents,
               (select to_char(max(s.sold_at at time zone 'Europe/Paris'), 'YYYY-MM-DD')
                  from app.sale_line l join app.sale s on s.id = l.sale_id where l.product_id = p.id) as last_sale
        from app.product p
        where p.status in ('ACTIVE', 'ON_ORDER') and p.stock_qty > 0
          and not exists (
            select 1 from app.sale_line l join app.sale s on s.id = l.sale_id
            where l.product_id = p.id and ${inRange('s.sold_at', from, to)})
        order by 4 desc limit 500`);
      const data = res.rows as Row[];
      return {
        title: 'Produits dormants',
        subtitle: `${subtitle} — en stock, sans aucune vente`,
        columns: [
          { key: 'code', label: 'Code', type: 'text' },
          { key: 'name', label: 'Produit', type: 'text', width: 3 },
          { key: 'qty', label: 'Stock', type: 'text' },
          { key: 'last', label: 'Dernière vente', type: 'text' },
          { key: 'value', label: 'Valeur immobilisée HT', type: 'money' },
        ],
        rows: [
          ...data.map((r) => ({
            cells: {
              code: String(r.code),
              name: String(r.name),
              qty: String(r.qty),
              last: r.last_sale ? String(r.last_sale) : 'jamais',
              value: eur(cents(r.cents)),
            },
          })),
          {
            bold: true,
            cells: {
              code: '',
              name: 'Total',
              qty: '',
              last: '',
              value: eur(data.reduce((t, r) => t + cents(r.cents), 0)),
            },
          },
        ],
      };
    }
    if (kind === 'hours') {
      const res = await db.execute(sql`
        select extract(isodow from s.sold_at at time zone 'Europe/Paris')::int as dow,
               extract(hour from s.sold_at at time zone 'Europe/Paris')::int as hour,
               count(*)::int as tickets, round(sum(s.total) * 100)::bigint as cents
        from app.sale s
        where s.cancels_sale_id is null and s.status = 'COMPLETED' and ${inRange('s.sold_at', from, to)}
        group by 1, 2 order by 1, 2`);
      const DAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
      return {
        title: 'Fréquentation par jour et heure',
        subtitle,
        columns: [
          { key: 'day', label: 'Jour', type: 'text' },
          { key: 'hour', label: 'Heure', type: 'text' },
          { key: 'tickets', label: 'Tickets', type: 'text' },
          { key: 'amount', label: 'CA TTC', type: 'money' },
        ],
        rows: (res.rows as Row[]).map((r) => ({
          cells: {
            day: DAYS[Number(r.dow)] ?? '',
            hour: `${String(r.hour).padStart(2, '0')} h`,
            tickets: String(r.tickets),
            amount: eur(cents(r.cents)),
          },
        })),
      };
    }
    if (kind === 'losses') {
      const res = await db.execute(sql`
        select p.code, p.name, sum(-m.qty)::text as qty,
               round(sum(-m.qty * coalesce(m.unit_cost, p.purchase_price_excl, 0)) * 100)::bigint as cents
        from app.stock_movement m join app.product p on p.id = m.product_id
        where m.kind = 'LOSS' and ${inRange('m.at', from, to)}
        group by p.id, p.code, p.name order by 4 desc`);
      const data = res.rows as Row[];
      return {
        title: 'Pertes et casse',
        subtitle,
        columns: [
          { key: 'code', label: 'Code', type: 'text' },
          { key: 'name', label: 'Produit', type: 'text', width: 3 },
          { key: 'qty', label: 'Quantité perdue', type: 'text' },
          { key: 'value', label: 'Valeur HT', type: 'money' },
        ],
        rows: [
          ...data.map((r) => ({
            cells: {
              code: String(r.code),
              name: String(r.name),
              qty: String(r.qty),
              value: eur(cents(r.cents)),
            },
          })),
          {
            bold: true,
            cells: {
              code: '',
              name: 'Total',
              qty: '',
              value: eur(data.reduce((t, r) => t + cents(r.cents), 0)),
            },
          },
        ],
      };
    }
    if (kind === 'forecast') {
      // Days of cover: current stock over the average daily sales of the period.
      const res = await db.execute(sql`
        with sold as (
          select l.product_id, sum(l.qty) as q
          from app.sale_line l join app.sale s on s.id = l.sale_id
          where ${inRange('s.sold_at', from, to)} group by 1)
        select p.code, p.name, p.stock_qty::text as stock,
               (sold.q / greatest(1, (${to}::date - ${from}::date + 1)))::numeric(12,3)::text as per_day,
               case when sold.q > 0 then round(p.stock_qty / (sold.q / greatest(1, (${to}::date - ${from}::date + 1))))::int end as cover
        from app.product p join sold on sold.product_id = p.id
        where p.status in ('ACTIVE', 'ON_ORDER') and sold.q > 0
        order by cover asc nulls last limit 300`);
      return {
        title: 'Autonomie de stock',
        subtitle: `${subtitle} — jours de stock restants au rythme de vente de la période`,
        columns: [
          { key: 'code', label: 'Code', type: 'text' },
          { key: 'name', label: 'Produit', type: 'text', width: 3 },
          { key: 'stock', label: 'Stock', type: 'text' },
          { key: 'perDay', label: 'Ventes / jour', type: 'text' },
          { key: 'cover', label: 'Jours de stock', type: 'text' },
        ],
        rows: (res.rows as Row[]).map((r) => ({
          cells: {
            code: String(r.code),
            name: String(r.name),
            stock: String(r.stock),
            perDay: String(r.per_day),
            cover: r.cover === null ? '' : String(r.cover),
          },
        })),
      };
    }
    if (kind === 'suggest') {
      // Order suggestion: cover 30 days of sales at the observed rate, back above min stock,
      // net of stock and of quantities already on order (R-CMD, automatic suggestion).
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);
      const res = await db.execute(sql`
        with sold as (
          select l.product_id, sum(l.qty) as q
          from app.sale_line l join app.sale s on s.id = l.sale_id
          where ${inRange('s.sold_at', from, to)} group by 1),
        ordered as (
          select pl.product_id, sum(pl.qty_ordered - pl.qty_received) as q
          from app.purchase_order_line pl join app.purchase_order po on po.id = pl.order_id
          where po.status in ('SENT', 'PARTIAL') group by 1)
        select p.code, p.name, coalesce(su.name, '') as supplier,
               p.stock_qty::text as stock, coalesce(p.min_stock, 0)::text as min_stock,
               coalesce(sold.q, 0)::text as sold, coalesce(ordered.q, 0)::text as on_order,
               coalesce(p.purchase_price_excl, 0)::text as price
        from app.product p
        left join sold on sold.product_id = p.id
        left join ordered on ordered.product_id = p.id
        left join app.supplier su on su.id = p.supplier_id
        where p.status = 'ACTIVE' and (sold.q > 0 or p.min_stock > 0)
          and (${q.supplierId ?? null}::uuid is null or p.supplier_id = ${q.supplierId ?? null}::uuid)`);
      const milli = (v: unknown) => Math.round(Number(v ?? 0) * 1000);
      const lines = (res.rows as Row[])
        .map((r) => {
          const qtyMilli = suggestOrderQtyMilli({
            stockMilli: milli(r.stock),
            soldMilli: milli(r.sold),
            periodDays: days,
            targetDays: 30,
            minStockMilli: milli(r.min_stock),
            onOrderMilli: milli(r.on_order),
          });
          return { r, qtyMilli, costCents: Math.round((qtyMilli / 1000) * Number(r.price) * 100) };
        })
        .filter((x) => x.qtyMilli > 0)
        .sort((a, b) => String(a.r.supplier).localeCompare(String(b.r.supplier), 'fr'));
      return {
        title: 'Suggestion de commande',
        subtitle: `${subtitle} — pour couvrir 30 jours au rythme de vente, net du stock et des commandes en cours`,
        columns: [
          { key: 'supplier', label: 'Fournisseur', type: 'text', width: 2 },
          { key: 'code', label: 'Code', type: 'text' },
          { key: 'name', label: 'Produit', type: 'text', width: 3 },
          { key: 'stock', label: 'Stock', type: 'text' },
          { key: 'onOrder', label: 'En commande', type: 'text' },
          { key: 'qty', label: 'À commander', type: 'text' },
          { key: 'cost', label: 'Coût estimé', type: 'money' },
        ],
        rows: [
          ...lines.map(({ r, qtyMilli, costCents }) => ({
            cells: {
              supplier: String(r.supplier),
              code: String(r.code),
              name: String(r.name),
              stock: String(r.stock),
              onOrder: String(r.on_order),
              qty: (qtyMilli / 1000).toFixed(3),
              cost: eur(costCents),
            },
          })),
          {
            bold: true,
            cells: {
              supplier: 'Total',
              code: '',
              name: '',
              stock: '',
              onOrder: '',
              qty: '',
              cost: eur(lines.reduce((t, x) => t + x.costCents, 0)),
            },
          },
        ],
      };
    }
    if (kind === 'cashgap') {
      // Closing difference (counted − expected) per cashier, fixed at closing time (R-SES-02).
      const res = await db.execute(sql`
        select coalesce(m.last_name || ' ' || m.first_name, 'Inconnu') as cashier,
               count(*)::int as n,
               round(sum(c.difference) * 100)::bigint as net,
               round(sum(abs(c.difference)) * 100)::bigint as abs_total,
               round(max(abs(c.difference)) * 100)::bigint as worst,
               count(*) filter (where c.difference <> 0)::int as with_gap
        from app.cash_count c
        join app.cash_session cs on cs.id = c.session_id
        left join app.member m on m.id = cs.closed_by
        where ${inRange('cs.closed_at', from, to)}
        group by 1 order by abs_total desc, 1`);
      const rows = res.rows as Row[];
      return {
        title: 'Écarts de caisse par caissier',
        subtitle,
        columns: [
          { key: 'cashier', label: 'Caissier', type: 'text', width: 2 },
          { key: 'n', label: 'Clôtures', type: 'text' },
          { key: 'withGap', label: 'Avec écart', type: 'text' },
          { key: 'net', label: 'Écart net', type: 'money' },
          { key: 'abs', label: 'Écart cumulé (valeur absolue)', type: 'money' },
          { key: 'worst', label: 'Pire écart', type: 'money' },
        ],
        rows: [
          ...rows.map((r) => ({
            cells: {
              cashier: String(r.cashier),
              n: String(r.n),
              withGap: String(r.with_gap),
              net: eur(cents(r.net)),
              abs: eur(cents(r.abs_total)),
              worst: eur(cents(r.worst)),
            },
          })),
          {
            bold: true,
            cells: {
              cashier: 'Total',
              n: String(rows.reduce((t, r) => t + Number(r.n), 0)),
              withGap: String(rows.reduce((t, r) => t + Number(r.with_gap), 0)),
              net: eur(rows.reduce((t, r) => t + cents(r.net), 0)),
              abs: eur(rows.reduce((t, r) => t + cents(r.abs_total), 0)),
              worst: eur(Math.max(0, ...rows.map((r) => cents(r.worst)))),
            },
          },
        ],
      };
    }
    if (kind === 'movements') {
      const res = await db.execute(sql`
        select m.kind, count(*)::int as n, sum(m.qty)::text as qty,
               round(sum(m.qty * coalesce(m.unit_cost, 0)) * 100)::bigint as cents
        from app.stock_movement m where ${inRange('m.at', from, to)}
        group by 1 order by 1`);
      return {
        title: 'Mouvements de stock',
        subtitle,
        columns: [
          { key: 'kind', label: 'Type', type: 'text', width: 2 },
          { key: 'n', label: 'Mouvements', type: 'text' },
          { key: 'qty', label: 'Quantité nette', type: 'text' },
          { key: 'value', label: 'Valeur au coût', type: 'money' },
        ],
        rows: (res.rows as Row[]).map((r) => ({
          cells: {
            kind: MOVEMENT_LABELS[String(r.kind)] ?? String(r.kind),
            n: String(r.n),
            qty: String(r.qty),
            value: eur(cents(r.cents)),
          },
        })),
      };
    }
    const res = await db.execute(sql`
      select h.number,
             (select coalesce(string_agg(m.last_name || ' ' || m.first_name, ', '), '')
                from app.member m where m.household_id = h.id) as names,
             count(*) filter (where s.cancels_sale_id is null)::int as tickets,
             round(sum(s.total) * 100)::bigint as cents
      from app.sale s join app.household h on h.id = s.household_id
      where ${inRange('s.sold_at', from, to)}
      group by h.id, h.number order by 4 desc`);
    return {
      title: 'Ventes par foyer',
      subtitle,
      columns: [
        { key: 'number', label: 'N° foyer', type: 'text' },
        { key: 'names', label: 'Membres', type: 'text', width: 3 },
        { key: 'tickets', label: 'Tickets', type: 'text' },
        { key: 'amount', label: 'Montant TTC', type: 'money' },
      ],
      rows: (res.rows as Row[]).map((r) => ({
        cells: {
          number: String(r.number),
          names: String(r.names),
          tickets: String(r.tickets),
          amount: eur(cents(r.cents)),
        },
      })),
    };
  }

  app.get(
    '/stats/report/:kind',
    {
      ...stats,
      schema: { params: z.object({ kind: z.enum(REPORT_KINDS) }), querystring: reportQuery },
    },
    async (req, reply) => {
      const table = await build(req.params.kind, req.query);
      if (req.query.format === 'json') return table;
      const file = `${req.params.kind}-${req.query.from}-${req.query.to}.xlsx`;
      return reply
        .header('content-disposition', `attachment; filename="${file}"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(await reportXlsx(table));
    },
  );
};
