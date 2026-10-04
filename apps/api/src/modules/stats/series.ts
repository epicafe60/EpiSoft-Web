import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '@episoft/db';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@episoft/shared';
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

export const REPORT_KINDS = ['payments', 'purchases', 'movements', 'households'] as const;
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
