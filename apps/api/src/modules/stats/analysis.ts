import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '@episoft/db';
import type { Config } from '../../config';
import { reportXlsx, type ReportTable } from '../../lib/report-output';

type Row = Record<string, unknown>;

export const ANALYSIS_GROUPS = [
  'product',
  'category',
  'universe',
  'supplier',
  'day',
  'month',
] as const;

const query = z.object({
  from: z.string().date(),
  to: z.string().date(),
  by: z.enum(ANALYSIS_GROUPS).default('product'),
  supplierId: z.string().uuid().optional(),
  universeId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
});

const GROUP_SQL: Record<(typeof ANALYSIS_GROUPS)[number], { key: SQL; label: SQL }> = {
  product: { key: sql`p.id::text`, label: sql`p.name` },
  category: { key: sql`c.id::text`, label: sql`coalesce(c.name, 'Sans rayon')` },
  universe: { key: sql`u.id::text`, label: sql`coalesce(u.name, 'Sans univers')` },
  supplier: { key: sql`sp.id::text`, label: sql`coalesce(sp.name, 'Sans fournisseur')` },
  day: {
    key: sql`to_char(s.sold_at at time zone 'Europe/Paris', 'YYYY-MM-DD')`,
    label: sql`to_char(s.sold_at at time zone 'Europe/Paris', 'YYYY-MM-DD')`,
  },
  month: {
    key: sql`to_char(s.sold_at at time zone 'Europe/Paris', 'YYYY-MM')`,
    label: sql`to_char(s.sold_at at time zone 'Europe/Paris', 'YYYY-MM')`,
  },
};

const GROUP_LABELS: Record<(typeof ANALYSIS_GROUPS)[number], string> = {
  product: 'Produit',
  category: 'Rayon',
  universe: 'Univers',
  supplier: 'Fournisseur',
  day: 'Jour',
  month: 'Mois',
};

const cents = (v: unknown) => Math.round(Number(v ?? 0));
const dec = (c: number) => (c / 100).toFixed(2);

/**
 * R-STA-03 — sales analysis with margin. Revenue is the net (cancellations are negative) amount
 * excluding VAT; the cost is the quantity at the current purchase price HT of the product, so
 * the margin is an estimate when prices changed over the period.
 */
export const analysisRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const stats = { preHandler: app.requireRoles('STATS') };

  async function analyse(q: z.infer<typeof query>) {
    const where: SQL[] = [
      sql`(s.sold_at at time zone 'Europe/Paris')::date between ${q.from}::date and ${q.to}::date`,
    ];
    if (q.supplierId) where.push(sql`p.supplier_id = ${q.supplierId}::uuid`);
    if (q.universeId) where.push(sql`c.universe_id = ${q.universeId}::uuid`);
    if (q.categoryId) where.push(sql`p.category_id = ${q.categoryId}::uuid`);
    if (q.productId) where.push(sql`p.id = ${q.productId}::uuid`);
    const g = GROUP_SQL[q.by];
    const res = await db.execute(sql`
      select ${g.key} as key, ${g.label} as label,
             sum(l.qty)::text as qty,
             round(sum(l.line_total) * 100)::bigint as ttc_cents,
             round(sum(l.line_total / (1 + l.vat_rate / 100)) * 100)::bigint as ht_cents,
             round(sum(l.qty * coalesce(p.purchase_price_excl, 0)) * 100)::bigint as cost_cents
      from app.sale_line l
        join app.sale s on s.id = l.sale_id
        join app.product p on p.id = l.product_id
        left join app.category c on c.id = p.category_id
        left join app.universe u on u.id = c.universe_id
        left join app.supplier sp on sp.id = p.supplier_id
      where ${sql.join(where, sql` and `)}
      group by 1, 2
      order by ${q.by === 'day' || q.by === 'month' ? sql`1` : sql`ht_cents desc`}`);
    const rows = (res.rows as Row[]).map((r) => {
      const ht = cents(r.ht_cents);
      const cost = cents(r.cost_cents);
      const margin = ht - cost;
      return {
        key: String(r.key),
        label: String(r.label),
        qty: String(r.qty),
        ttcCents: cents(r.ttc_cents),
        htCents: ht,
        costCents: cost,
        marginCents: margin,
        marginRatePct: ht > 0 ? Math.round((margin / ht) * 10_000) / 100 : null,
      };
    });
    const total = rows.reduce(
      (t, r) => ({
        ttcCents: t.ttcCents + r.ttcCents,
        htCents: t.htCents + r.htCents,
        costCents: t.costCents + r.costCents,
        marginCents: t.marginCents + r.marginCents,
      }),
      { ttcCents: 0, htCents: 0, costCents: 0, marginCents: 0 },
    );
    return {
      ...q,
      rows,
      total: {
        ...total,
        marginRatePct:
          total.htCents > 0 ? Math.round((total.marginCents / total.htCents) * 10_000) / 100 : null,
      },
    };
  }

  /** Filter choices of the statistics screen. */
  app.get('/stats/refs', stats, async () => {
    const [universes, categories, suppliers] = await Promise.all([
      db.execute(sql`select id, name from app.universe order by sort, name`),
      db.execute(sql`select id, name, universe_id as "universeId" from app.category order by name`),
      db.execute(sql`select id, name from app.supplier order by name`),
    ]);
    return {
      universes: universes.rows,
      categories: categories.rows,
      suppliers: suppliers.rows,
    };
  });

  app.get('/stats/analysis', { ...stats, schema: { querystring: query } }, async (req, reply) => {
    const a = await analyse(req.query);
    if (req.query.format === 'json') return a;
    const table: ReportTable = {
      title: 'Analyse des ventes',
      subtitle: `Du ${a.from} au ${a.to} — par ${GROUP_LABELS[a.by].toLowerCase()}`,
      columns: [
        { key: 'label', label: GROUP_LABELS[a.by], type: 'text', width: 3 },
        { key: 'qty', label: 'Quantité', type: 'text' },
        { key: 'ttc', label: 'CA TTC', type: 'money' },
        { key: 'ht', label: 'CA HT', type: 'money' },
        { key: 'cost', label: 'Coût HT', type: 'money' },
        { key: 'margin', label: 'Marge', type: 'money' },
        { key: 'rate', label: 'Taux de marge %', type: 'text' },
      ],
      rows: [
        ...a.rows.map((r) => ({
          cells: {
            label: r.label,
            qty: r.qty,
            ttc: dec(r.ttcCents),
            ht: dec(r.htCents),
            cost: dec(r.costCents),
            margin: dec(r.marginCents),
            rate: r.marginRatePct === null ? '' : String(r.marginRatePct),
          },
        })),
        {
          bold: true,
          cells: {
            label: 'Total',
            qty: '',
            ttc: dec(a.total.ttcCents),
            ht: dec(a.total.htCents),
            cost: dec(a.total.costCents),
            margin: dec(a.total.marginCents),
            rate: a.total.marginRatePct === null ? '' : String(a.total.marginRatePct),
          },
        },
      ],
    };
    return reply
      .header('content-disposition', `attachment; filename="analyse-ventes-${a.from}-${a.to}.xlsx"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(await reportXlsx(table));
  });
};
