import bwipjs from 'bwip-js/node';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  category,
  priceHistory,
  product,
  productBarcode,
  supplier,
  universe,
  type Db,
} from '@episoft/db';
import {
  bulkPricesSchema,
  categorySchema,
  centsToDecimal,
  decimalToCents,
  inclFromExcl4,
  labelsSchema,
  parsePrice4,
  parseQtyToMilli,
  price4ToDecimal,
  pricePerKgOrLitreCents,
  QUALITY_LABELS,
  universeSchema,
  type Quality,
  type Unit,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { eur, pdfText, render } from '../../lib/pdf';
import { conflict, notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';

const idParams = { params: z.object({ id: z.string().uuid() }) };

export const catalogAdminRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const editors = { preHandler: app.requireRoles('PRODUITS') };

  // --- Universes and shelves (R-PRD-09) --------------------------------------------------

  app.post('/universes', { ...editors, schema: { body: universeSchema } }, async (req) =>
    db.transaction(async (tx) => {
      if (await tx.query.universe.findFirst({ where: eq(universe.code, req.body.code) }))
        throw conflict('Ce code d’univers existe déjà.');
      const [u] = await tx.insert(universe).values(req.body).returning();
      await audit(tx, req, {
        action: 'universe.create',
        entity: 'universe',
        entityId: u!.id,
        after: u,
      });
      return u;
    }),
  );

  app.put(
    '/universes/:id',
    { ...editors, schema: { ...idParams, body: universeSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [before] = await tx.select().from(universe).where(eq(universe.id, req.params.id));
        if (!before) throw notFound('Univers introuvable.');
        const [after] = await tx
          .update(universe)
          .set(req.body)
          .where(eq(universe.id, before.id))
          .returning();
        await audit(tx, req, {
          action: 'universe.update',
          entity: 'universe',
          entityId: before.id,
          before,
          after,
        });
        return after;
      }),
  );

  app.post('/categories', { ...editors, schema: { body: categorySchema } }, async (req) =>
    db.transaction(async (tx) => {
      const [c] = await tx.insert(category).values(req.body).onConflictDoNothing().returning();
      if (!c) throw conflict('Ce code de rayon existe déjà dans cet univers.');
      await audit(tx, req, {
        action: 'category.create',
        entity: 'category',
        entityId: c.id,
        after: c,
      });
      return c;
    }),
  );

  app.put(
    '/categories/:id',
    { ...editors, schema: { ...idParams, body: categorySchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [before] = await tx.select().from(category).where(eq(category.id, req.params.id));
        if (!before) throw notFound('Rayon introuvable.');
        const [after] = await tx
          .update(category)
          .set(req.body)
          .where(eq(category.id, before.id))
          .returning();
        await audit(tx, req, {
          action: 'category.update',
          entity: 'category',
          entityId: before.id,
          before,
          after,
        });
        return after;
      }),
  );

  // --- Bulk prices for a supplier (R-PRD-08) ----------------------------------------------

  app.get(
    '/suppliers/:id/price-grid',
    { preHandler: app.requireRoles('PRODUITS', 'APPROS'), schema: idParams },
    async (req) => {
      const s = await db.query.supplier.findFirst({ where: eq(supplier.id, req.params.id) });
      if (!s) throw notFound('Fournisseur introuvable.');
      return db
        .select({
          productId: product.id,
          code: product.code,
          name: product.name,
          supplierRef: product.supplierRef,
          purchasePriceExcl: product.purchasePriceExcl,
          purchasePriceIncl: product.purchasePriceIncl,
          vatRate: product.vatRate,
          salePrice: product.salePrice,
          status: product.status,
        })
        .from(product)
        .where(eq(product.supplierId, s.id))
        .orderBy(asc(product.name));
    },
  );

  /** Applies a validated grid at once; every change is in the price history (source BULK). */
  app.post(
    '/products/bulk-prices',
    { ...editors, schema: { body: bulkPricesSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const rows = req.body.rows;
        const current = await tx
          .select()
          .from(product)
          .where(
            inArray(
              product.id,
              rows.map((r) => r.productId),
            ),
          );
        const byId = new Map(current.map((p) => [p.id, p]));
        let changed = 0;
        for (const r of rows) {
          const p = byId.get(r.productId);
          if (!p) throw notFound('Produit introuvable.');
          const incl = r.purchasePriceExcl
            ? price4ToDecimal(inclFromExcl4(parsePrice4(r.purchasePriceExcl)!, r.vatRate))
            : null;
          const status = r.active ? (p.status === 'INACTIVE' ? 'ACTIVE' : p.status) : 'INACTIVE';
          const priceChanged =
            decimalToCents(r.salePrice) !== decimalToCents(p.salePrice) ||
            (parsePrice4(r.purchasePriceExcl) ?? 0) !== (parsePrice4(p.purchasePriceExcl) ?? 0) ||
            r.vatRate !== p.vatRate;
          if (!priceChanged && status === p.status) continue;
          await tx
            .update(product)
            .set({
              purchasePriceExcl: r.purchasePriceExcl,
              purchasePriceIncl: incl,
              vatRate: r.vatRate,
              salePrice: r.salePrice,
              status,
              ...(decimalToCents(r.salePrice) !== decimalToCents(p.salePrice)
                ? { labelPending: true }
                : {}),
            })
            .where(eq(product.id, p.id));
          if (priceChanged) {
            await tx.insert(priceHistory).values({
              productId: p.id,
              purchasePriceExcl: r.purchasePriceExcl,
              purchasePriceIncl: incl,
              salePrice: r.salePrice,
              source: 'BULK',
              by: req.user!.id,
            });
          }
          changed++;
        }
        await audit(tx, req, {
          action: 'product.bulk_prices',
          entity: 'product',
          after: { rows: rows.length, changed },
        });
        return { changed };
      }),
  );

  // --- Labels (R-PRD-06) ------------------------------------------------------------------------

  /** A4 sheet of 24 (3 × 8) or 40 (4 × 10) labels: name, price, price per kg/L, origin, barcode. */
  app.post(
    '/products/labels/pdf',
    { ...editors, schema: { body: labelsSchema } },
    async (req, reply) => {
      const settings = await loadSettings(db);
      const perPage = req.body.perPage ?? settings['labels.layout'].perPage;
      const prods = await db
        .select({
          id: product.id,
          code: product.code,
          name: product.name,
          salePrice: product.salePrice,
          unit: product.unit,
          unitQty: product.unitQty,
          saleMode: product.saleMode,
          qualities: product.qualities,
          supplierName: supplier.name,
        })
        .from(product)
        .leftJoin(supplier, eq(supplier.id, product.supplierId))
        .where(inArray(product.id, req.body.productIds))
        .orderBy(product.name);
      const eans = await db
        .select()
        .from(productBarcode)
        .where(inArray(productBarcode.productId, req.body.productIds));
      const barcodes = new Map<string, Buffer>();
      for (const p of req.body.barcode ? prods : []) {
        const ean = eans.find((e) => e.productId === p.id)?.ean;
        barcodes.set(
          p.id,
          await bwipjs.toBuffer({
            bcid: ean ? (ean.length === 8 ? 'ean8' : 'ean13') : 'code128',
            text: ean ?? p.code,
            scale: 2,
            height: 8,
            includetext: true,
            textsize: 8,
          }),
        );
      }
      const cols = perPage === 24 ? 3 : 4;
      const rowsPerPage = perPage === 24 ? 8 : 10;
      const pdf = await render(
        (doc) => {
          const margin = 15;
          const w = (doc.page.width - 2 * margin) / cols;
          const h = (doc.page.height - 2 * margin) / rowsPerPage;
          prods.forEach((p, i) => {
            if (i > 0 && i % perPage === 0) doc.addPage();
            const k = i % perPage;
            const x = margin + (k % cols) * w;
            const y = margin + Math.floor(k / cols) * h;
            const pad = 6;
            doc
              .rect(x + 1, y + 1, w - 2, h - 2)
              .strokeColor('#bbbbbb')
              .lineWidth(0.5)
              .stroke();
            doc
              .font('Helvetica-Bold')
              .fontSize(perPage === 24 ? 9 : 8)
              .fillColor('black')
              .text(pdfText(p.name), x + pad, y + pad, {
                width: w - 2 * pad,
                height: h * 0.32,
                ellipsis: true,
              });
            const perUnit = p.unit
              ? pricePerKgOrLitreCents(
                  decimalToCents(p.salePrice),
                  parseQtyToMilli(p.unitQty ?? '0') ?? 0,
                  p.unit as Unit,
                )
              : null;
            const unitLabel =
              p.saleMode === 'UNIT'
                ? ''
                : p.unit === 'G' || p.unit === 'KG'
                  ? ' le kg'
                  : ' le litre';
            doc
              .font('Helvetica-Bold')
              .fontSize(perPage === 24 ? 18 : 14)
              .text(eur(p.salePrice) + unitLabel, x + pad, y + h * 0.36, { width: w - 2 * pad });
            const small: string[] = [];
            if (perUnit !== null && p.saleMode === 'UNIT')
              small.push(
                `${eur(centsToDecimal(perUnit))} ${p.unit === 'G' || p.unit === 'KG' ? 'le kg' : 'le L'}`,
              );
            const origin = [
              ...(p.qualities as Quality[])
                .filter((q) => q !== 'STANDARD')
                .map((q) => QUALITY_LABELS[q]),
              p.supplierName,
            ]
              .filter(Boolean)
              .join(' · ');
            if (origin) small.push(origin);
            doc
              .font('Helvetica')
              .fontSize(6.5)
              .text(pdfText(small.join(' — ')), x + pad, y + h * 0.58, {
                width: req.body.barcode ? w * 0.48 : w - 2 * pad,
                height: h * 0.35,
              });
            if (req.body.barcode)
              doc.image(barcodes.get(p.id)!, x + w * 0.5, y + h * 0.56, {
                fit: [w * 0.48 - pad, h * 0.38],
              });
            // R-EVO-07: red dot for a local product, green dot for an organic one.
            const dots: string[] = [];
            if ((p.qualities as Quality[]).includes('LOCAL')) dots.push('#d62828');
            if ((p.qualities as Quality[]).includes('ORGANIC')) dots.push('#2a9d3f');
            dots.forEach((color, d) =>
              doc
                .circle(x + w - pad - 5 - d * 14, y + pad + 5, 5)
                .fillColor(color)
                .fill(),
            );
            doc.fillColor('black');
          });
        },
        { margin: 0 },
      );
      if (req.body.markDone) {
        await db
          .update(product)
          .set({ labelPending: false })
          .where(inArray(product.id, req.body.productIds));
      }
      return reply
        .header('content-disposition', 'inline; filename="etiquettes.pdf"')
        .type('application/pdf')
        .send(pdf);
    },
  );
};
