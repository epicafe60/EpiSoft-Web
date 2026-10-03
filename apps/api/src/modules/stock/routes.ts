import ExcelJS from 'exceljs';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  category,
  inventoryLine,
  inventorySession,
  member,
  product,
  stockMovement,
  supplier,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  centsToDecimal,
  correctionSchema,
  inventoryAdjustmentMilli,
  inventoryCountSchema,
  inventoryCreateSchema,
  inventoryValidateSchema,
  lossSchema,
  milliToDecimal,
  parsePrice4,
  parseQtyToMilli,
  stockValueCents,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { recordMovement } from './ledger';

const idParams = { params: z.object({ id: z.string().uuid() }) };
const milli = (v: string | null | undefined) =>
  v === null || v === undefined ? 0 : (parseQtyToMilli(v) ?? 0);

/** Sum of the movements of a product in (from, to], excluding inventory adjustments. */
async function movedBetween(tx: Db | Tx, productId: string, from: Date, to: Date): Promise<number> {
  const [row] = await tx
    .select({ q: sql<string>`coalesce(sum(${stockMovement.qty}), 0)::text` })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.productId, productId),
        gt(stockMovement.at, from),
        lte(stockMovement.at, to),
        ne(stockMovement.kind, 'INVENTORY'),
      ),
    );
  return milli(row!.q);
}

export const stockRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const readers = { preHandler: app.requireRoles('APPROS', 'PRODUITS', 'COMPTA') };
  const appros = { preHandler: app.requireRoles('APPROS') };

  /** R-STK-05: movements of a product with the running balance, no hard-coded start. */
  app.get(
    '/stock/movements',
    { ...readers, schema: { querystring: z.object({ productId: z.string().uuid() }) } },
    async (req) => {
      const rows = await db
        .select({
          id: stockMovement.id,
          at: stockMovement.at,
          qty: stockMovement.qty,
          kind: stockMovement.kind,
          unitCost: stockMovement.unitCost,
          sourceType: stockMovement.sourceType,
          sourceId: stockMovement.sourceId,
          comment: stockMovement.comment,
          byName: sql<string | null>`${member.firstName} || ' ' || ${member.lastName}`,
          balance: sql<string>`(sum(${stockMovement.qty}) over (order by ${stockMovement.at}, ${stockMovement.id}))::text`,
        })
        .from(stockMovement)
        .leftJoin(member, eq(member.id, stockMovement.by))
        .where(eq(stockMovement.productId, req.query.productId))
        .orderBy(asc(stockMovement.at), asc(stockMovement.id));
      return rows.reverse().map((r) => ({ ...r, at: r.at.toISOString() }));
    },
  );

  /** R-STK-03: loss, breakage, expiry or internal use. */
  app.post('/stock/losses', { ...appros, schema: { body: lossSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const p = await tx.query.product.findFirst({ where: eq(product.id, req.body.productId) });
      if (!p) throw notFound('Produit introuvable.');
      if (p.kind !== 'GOODS') throw badRequest('Un service n’a pas de stock.');
      await recordMovement(tx, {
        productId: p.id,
        qtyMilli: -milli(req.body.qty),
        kind: 'LOSS',
        unitCost: p.purchasePriceExcl,
        comment: req.body.reason,
        by: req.user!.id,
        sourceType: 'loss',
      });
      await audit(tx, req, {
        action: 'stock.loss',
        entity: 'product',
        entityId: p.id,
        after: req.body,
      });
      return { ok: true };
    }),
  );

  app.post('/stock/corrections', { ...appros, schema: { body: correctionSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const p = await tx.query.product.findFirst({ where: eq(product.id, req.body.productId) });
      if (!p) throw notFound('Produit introuvable.');
      await recordMovement(tx, {
        productId: p.id,
        qtyMilli: milli(req.body.qty),
        kind: 'CORRECTION',
        unitCost: p.purchasePriceExcl,
        comment: req.body.comment,
        by: req.user!.id,
        sourceType: 'correction',
      });
      await audit(tx, req, {
        action: 'stock.correction',
        entity: 'product',
        entityId: p.id,
        after: req.body,
      });
      return { ok: true };
    }),
  );

  /** R-PRD-10: products under their minimum stock. */
  app.get('/stock/to-order', readers, async () =>
    db
      .select({
        id: product.id,
        code: product.code,
        name: product.name,
        stockQty: product.stockQty,
        minStock: product.minStock,
        supplierId: product.supplierId,
        supplierName: supplier.name,
      })
      .from(product)
      .leftJoin(supplier, eq(supplier.id, product.supplierId))
      .where(
        and(
          isNotNull(product.minStock),
          sql`${product.stockQty} < ${product.minStock}`,
          inArray(product.status, ['ACTIVE', 'ON_ORDER']),
          eq(product.kind, 'GOODS'),
        ),
      )
      .orderBy(supplier.name, product.name),
  );

  /** R-STK-06: stock value at a date, at the purchase price HT or TTC of that date. */
  const valuation = async (date: string, basis: 'excl' | 'incl') => {
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
  };
  const valuationQuery = z.object({
    date: z.string().date(),
    basis: z.enum(['excl', 'incl']).default('excl'),
  });

  app.get(
    '/stock/valuation',
    { ...readers, schema: { querystring: valuationQuery } },
    async (req) => valuation(req.query.date, req.query.basis),
  );

  app.get(
    '/stock/valuation.xlsx',
    { ...readers, schema: { querystring: valuationQuery } },
    async (req, reply) => {
      const v = await valuation(req.query.date, req.query.basis);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Valorisation');
      ws.columns = [
        { header: 'Code', key: 'code', width: 10 },
        { header: 'Produit', key: 'name', width: 40 },
        { header: 'Rayon', key: 'category', width: 24 },
        { header: 'Quantité', key: 'qty', width: 10 },
        { header: `PA ${v.basis === 'excl' ? 'HT' : 'TTC'}`, key: 'price', width: 10 },
        { header: 'Valeur', key: 'value', width: 12, style: { numFmt: '#,##0.00 €' } },
      ];
      ws.getRow(1).font = { bold: true };
      for (const r of v.rows)
        ws.addRow({
          ...r,
          qty: Number(r.qty),
          price: r.price ? Number(r.price) : null,
          value: Number(r.value),
        });
      ws.addRow({ name: `Total au ${v.date}`, value: Number(v.total) }).font = { bold: true };
      const buf = await wb.xlsx.writeBuffer();
      return reply
        .header('content-disposition', `attachment; filename="valorisation-${v.date}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(Buffer.from(buf));
    },
  );

  // --- Inventory (R-STK-04) ------------------------------------------------------------------

  app.get('/inventories', readers, async () =>
    db
      .select({
        id: inventorySession.id,
        label: inventorySession.label,
        status: inventorySession.status,
        openedAt: inventorySession.openedAt,
        validatedAt: inventorySession.validatedAt,
        lines: sql<number>`(select count(*)::int from app.inventory_line l where l.session_id = ${inventorySession.id})`,
        counted: sql<number>`(select count(*)::int from app.inventory_line l where l.session_id = ${inventorySession.id} and l.counted_qty is not null)`,
      })
      .from(inventorySession)
      .orderBy(desc(inventorySession.openedAt))
      .limit(100),
  );

  /** Opens a session: the theoretical stock is frozen now (R-STK-04). */
  app.post('/inventories', { ...appros, schema: { body: inventoryCreateSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const { scope } = req.body;
      const f: SQL[] = [eq(product.kind, 'GOODS'), ne(product.status, 'INACTIVE')];
      if (scope.supplierId) f.push(eq(product.supplierId, scope.supplierId));
      if (scope.categoryId) f.push(eq(product.categoryId, scope.categoryId));
      if (scope.productIds?.length) f.push(inArray(product.id, scope.productIds));
      const prods = await tx
        .select()
        .from(product)
        .where(and(...f));
      if (!prods.length) throw badRequest('Aucun produit dans ce périmètre.');
      const [s] = await tx
        .insert(inventorySession)
        .values({ label: req.body.label, scope, openedBy: req.user!.id })
        .returning();
      await tx
        .insert(inventoryLine)
        .values(
          prods.map((p) => ({
            sessionId: s!.id,
            productId: p.id,
            theoreticalQty: p.stockQty,
            unitCostExcl: p.purchasePriceExcl,
            unitCostIncl: p.purchasePriceIncl,
          })),
        );
      await audit(tx, req, {
        action: 'inventory.open',
        entity: 'inventory_session',
        entityId: s!.id,
        after: { label: s!.label, scope, products: prods.length },
      });
      return { id: s!.id };
    }),
  );

  const sessionDetail = async (id: string) => {
    const s = await db.query.inventorySession.findFirst({ where: eq(inventorySession.id, id) });
    if (!s) return null;
    const lines = await db
      .select({
        productId: inventoryLine.productId,
        code: product.code,
        name: product.name,
        unit: product.unit,
        saleMode: product.saleMode,
        categoryName: category.name,
        theoreticalQty: inventoryLine.theoreticalQty,
        countedQty: inventoryLine.countedQty,
        countedAt: inventoryLine.countedAt,
        adjustment: inventoryLine.adjustment,
        unitCostExcl: inventoryLine.unitCostExcl,
        unitCostIncl: inventoryLine.unitCostIncl,
        eans: sql<
          string[]
        >`coalesce((select array_agg(b.ean) from app.product_barcode b where b.product_id = ${product.id}), '{}')`,
      })
      .from(inventoryLine)
      .innerJoin(product, eq(product.id, inventoryLine.productId))
      .leftJoin(category, eq(category.id, product.categoryId))
      .where(eq(inventoryLine.sessionId, id))
      .orderBy(product.name);
    return {
      ...s,
      openedAt: s.openedAt.toISOString(),
      validatedAt: s.validatedAt?.toISOString() ?? null,
      lines: lines.map((l) => ({ ...l, countedAt: l.countedAt?.toISOString() ?? null })),
    };
  };

  app.get('/inventories/:id', { ...readers, schema: idParams }, async (req) => {
    const d = await sessionDetail(req.params.id);
    if (!d) throw notFound('Inventaire introuvable.');
    return d;
  });

  /** Counting on a phone: cumulative ("add") or replacing ("set"). A product outside the scope can be added. */
  app.put(
    '/inventories/:id/lines/:productId',
    {
      ...appros,
      schema: {
        params: z.object({ id: z.string().uuid(), productId: z.string().uuid() }),
        body: inventoryCountSchema,
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const [s] = await tx
          .select()
          .from(inventorySession)
          .where(eq(inventorySession.id, req.params.id))
          .for('update');
        if (!s) throw notFound('Inventaire introuvable.');
        if (s.status !== 'OPEN') throw conflict('Cet inventaire est clos.');
        let [line] = await tx
          .select()
          .from(inventoryLine)
          .where(
            and(
              eq(inventoryLine.sessionId, s.id),
              eq(inventoryLine.productId, req.params.productId),
            ),
          );
        if (!line) {
          const p = await tx.query.product.findFirst({
            where: eq(product.id, req.params.productId),
          });
          if (!p || p.kind !== 'GOODS') throw notFound('Produit introuvable.');
          // Theoretical stock at the opening of the session.
          const since = await movedBetween(tx, p.id, s.openedAt, new Date());
          [line] = await tx
            .insert(inventoryLine)
            .values({
              sessionId: s.id,
              productId: p.id,
              theoreticalQty: milliToDecimal(milli(p.stockQty) - since),
              unitCostExcl: p.purchasePriceExcl,
              unitCostIncl: p.purchasePriceIncl,
            })
            .returning();
        }
        const counted =
          req.body.mode === 'add' && line!.countedQty !== null
            ? milli(line!.countedQty) + milli(req.body.qty)
            : milli(req.body.qty);
        await tx
          .update(inventoryLine)
          .set({
            countedQty: milliToDecimal(counted),
            countedAt: new Date(),
            countedBy: req.user!.id,
          })
          .where(
            and(eq(inventoryLine.sessionId, s.id), eq(inventoryLine.productId, line!.productId)),
          );
        return { productId: line!.productId, countedQty: milliToDecimal(counted) };
      }),
  );

  /**
   * Validation: only counted products get an INVENTORY movement, worth counted − (theoretical
   * + movements between opening and count). Uncounted products are untouched unless the user
   * explicitly asks to set them to zero.
   */
  app.post(
    '/inventories/:id/validate',
    { ...appros, schema: { ...idParams, body: inventoryValidateSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [s] = await tx
          .select()
          .from(inventorySession)
          .where(eq(inventorySession.id, req.params.id))
          .for('update');
        if (!s) throw notFound('Inventaire introuvable.');
        if (s.status !== 'OPEN') throw conflict('Cet inventaire est déjà clos.');
        const now = new Date();
        const lines = await tx
          .select()
          .from(inventoryLine)
          .where(eq(inventoryLine.sessionId, s.id));
        let adjusted = 0;
        for (const l of lines) {
          let adjustment: number | null = null;
          if (l.countedQty !== null) {
            const moved = await movedBetween(tx, l.productId, s.openedAt, l.countedAt!);
            adjustment = inventoryAdjustmentMilli(
              milli(l.theoreticalQty),
              moved,
              milli(l.countedQty),
            );
          } else if (req.body.zeroUncounted) {
            const moved = await movedBetween(tx, l.productId, s.openedAt, now);
            adjustment = inventoryAdjustmentMilli(milli(l.theoreticalQty), moved, 0);
          }
          if (adjustment === null) continue;
          await tx
            .update(inventoryLine)
            .set({ adjustment: milliToDecimal(adjustment) })
            .where(
              and(eq(inventoryLine.sessionId, s.id), eq(inventoryLine.productId, l.productId)),
            );
          if (adjustment !== 0) {
            await recordMovement(tx, {
              productId: l.productId,
              qtyMilli: adjustment,
              kind: 'INVENTORY',
              unitCost: l.unitCostExcl,
              sourceType: 'inventory',
              sourceId: s.id,
              by: req.user!.id,
              comment: s.label,
              at: now,
            });
            adjusted++;
          }
        }
        await tx
          .update(inventorySession)
          .set({
            status: 'VALIDATED',
            validatedAt: now,
            validatedBy: req.user!.id,
            zeroUncounted: req.body.zeroUncounted,
          })
          .where(eq(inventorySession.id, s.id));
        await audit(tx, req, {
          action: 'inventory.validate',
          entity: 'inventory_session',
          entityId: s.id,
          after: { adjusted, zeroUncounted: req.body.zeroUncounted },
        });
        return { adjusted };
      }),
  );

  app.post('/inventories/:id/cancel', { ...appros, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(inventorySession)
        .where(eq(inventorySession.id, req.params.id))
        .for('update');
      if (!s) throw notFound('Inventaire introuvable.');
      if (s.status !== 'OPEN') throw conflict('Cet inventaire est déjà clos.');
      await tx
        .update(inventorySession)
        .set({ status: 'CANCELLED' })
        .where(eq(inventorySession.id, s.id));
      await audit(tx, req, {
        action: 'inventory.cancel',
        entity: 'inventory_session',
        entityId: s.id,
      });
      return { ok: true };
    }),
  );

  /** R-STK-04: differences in quantity and value at PA HT and PA TTC. */
  app.get('/inventories/:id/report', { ...readers, schema: idParams }, async (req) => {
    const d = await sessionDetail(req.params.id);
    if (!d) throw notFound('Inventaire introuvable.');
    const rows = d.lines
      .filter((l) => l.adjustment !== null && milli(l.adjustment) !== 0)
      .map((l) => {
        const q = milli(l.adjustment);
        const value = (p: string | null) => {
          const v = stockValueCents(Math.abs(q), parsePrice4(p));
          return centsToDecimal(q < 0 ? -v : v);
        };
        return {
          productId: l.productId,
          code: l.code,
          name: l.name,
          theoreticalQty: l.theoreticalQty,
          countedQty: l.countedQty,
          adjustment: l.adjustment,
          valueExcl: value(l.unitCostExcl),
          valueIncl: value(l.unitCostIncl),
        };
      });
    const sum = (k: 'valueExcl' | 'valueIncl') =>
      centsToDecimal(rows.reduce((s, r) => s + Math.round(Number(r[k]) * 100), 0));
    return {
      session: {
        id: d.id,
        label: d.label,
        status: d.status,
        openedAt: d.openedAt,
        validatedAt: d.validatedAt,
      },
      rows,
      totalExcl: sum('valueExcl'),
      totalIncl: sum('valueIncl'),
      uncounted: d.lines.filter((l) => l.countedQty === null).length,
    };
  });
};
