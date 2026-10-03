import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  category,
  media,
  posTab,
  priceHistory,
  product,
  productBarcode,
  saleLine,
  supplier,
  universe,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  normalizeSearch,
  PRODUCT_STATUSES,
  productCreateSchema,
  productPatchSchema,
  purchasePriceIncl,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { fold } from '../members/routes';

const idParams = { params: z.object({ id: z.string().uuid() }) };
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 1024 * 1024;

export const catalogRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const readers = { preHandler: app.requireRoles('PRODUITS', 'CAISSE', 'APPROS') };
  const editors = { preHandler: app.requireRoles('PRODUITS') };

  app.addContentTypeParser(
    IMAGE_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
    (_req, body, done) => done(null, body),
  );

  /** Lists for the product form and filters. */
  app.get('/catalog/refs', readers, async () => ({
    universes: await db.select().from(universe).orderBy(universe.sort, universe.code),
    categories: await db.select().from(category).orderBy(category.sort, category.code),
    suppliers: await db
      .select({
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        active: supplier.active,
      })
      .from(supplier)
      .orderBy(supplier.name),
    posTabs: await db.select().from(posTab).orderBy(posTab.sort),
  }));

  app.get(
    '/products',
    {
      ...readers,
      schema: {
        querystring: z.object({
          q: z.string().max(100).optional(),
          status: z.enum(PRODUCT_STATUSES).optional(),
          categoryId: z.string().uuid().optional(),
          labelPending: z.enum(['true']).optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(200),
        }),
      },
    },
    async (req) => {
      const f: SQL[] = [];
      const q = req.query.q?.trim();
      if (q) {
        const words = normalizeSearch(q).split(' ');
        f.push(
          or(
            eq(product.code, q),
            sql`exists (select 1 from app.product_barcode b where b.product_id = ${product.id} and b.ean = ${q})`,
            and(...words.map((w) => sql`${fold(product.name)} like ${'%' + w + '%'}`)),
          )!,
        );
      }
      if (req.query.status) f.push(eq(product.status, req.query.status));
      if (req.query.categoryId) f.push(eq(product.categoryId, req.query.categoryId));
      if (req.query.labelPending) f.push(eq(product.labelPending, true));
      const rows = await db
        .select({
          id: product.id,
          code: product.code,
          name: product.name,
          kind: product.kind,
          status: product.status,
          salePrice: product.salePrice,
          stockQty: product.stockQty,
          minStock: product.minStock,
          saleMode: product.saleMode,
          unit: product.unit,
          labelPending: product.labelPending,
          categoryName: category.name,
          supplierName: supplier.name,
          imageId: product.imageId,
        })
        .from(product)
        .leftJoin(category, eq(category.id, product.categoryId))
        .leftJoin(supplier, eq(supplier.id, product.supplierId))
        .where(and(...f))
        .orderBy(asc(product.code))
        .limit(req.query.limit);
      return rows;
    },
  );

  app.get('/products/:id', { ...readers, schema: idParams }, async (req) => {
    const p = await db.query.product.findFirst({ where: eq(product.id, req.params.id) });
    if (!p) throw notFound('Produit introuvable.');
    const eans = await db
      .select({ ean: productBarcode.ean })
      .from(productBarcode)
      .where(eq(productBarcode.productId, p.id));
    const prices = await db
      .select()
      .from(priceHistory)
      .where(eq(priceHistory.productId, p.id))
      .orderBy(sql`${priceHistory.at} desc`)
      .limit(50);
    const [sold] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(saleLine)
      .where(eq(saleLine.productId, p.id));
    return {
      ...p,
      eans: eans.map((e) => e.ean),
      hasSales: sold!.n > 0,
      priceHistory: prices.map((h) => ({ ...h, at: h.at.toISOString() })),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  });

  /** R-PRD-01: next code of a shelf = universe + shelf + sequence. */
  app.get(
    '/products/next-code',
    { ...editors, schema: { querystring: z.object({ categoryId: z.string().uuid() }) } },
    async (req) => ({
      code: await nextProductCode(db, req.query.categoryId),
    }),
  );

  app.post('/products', { ...editors, schema: { body: productCreateSchema } }, async (req) => {
    const { eans, code, ...fields } = req.body;
    return db.transaction(async (tx) => {
      const finalCode =
        code ?? (fields.categoryId ? await nextProductCode(tx, fields.categoryId) : null);
      if (!finalCode) throw badRequest('Choisissez un rayon ou saisissez un code.');
      if (await tx.query.product.findFirst({ where: eq(product.code, finalCode) }))
        throw conflict(`Le code ${finalCode} est déjà utilisé.`);
      await assertFreeEans(tx, eans, null);
      const [p] = await tx
        .insert(product)
        .values({
          ...fields,
          code: finalCode,
          purchasePriceIncl: fields.purchasePriceExcl
            ? purchasePriceIncl(fields.purchasePriceExcl, fields.vatRate)
            : null,
          // R-PRD-06: a new product goes to the label queue.
          labelPending: fields.kind === 'GOODS',
          createdOn: sql`current_date`,
        })
        .returning();
      if (eans.length)
        await tx.insert(productBarcode).values(eans.map((ean) => ({ ean, productId: p!.id })));
      await tx.insert(priceHistory).values({
        productId: p!.id,
        purchasePriceExcl: p!.purchasePriceExcl,
        purchasePriceIncl: p!.purchasePriceIncl,
        salePrice: p!.salePrice,
        source: 'FORM',
        by: req.user!.id,
      });
      await audit(tx, req, {
        action: 'product.create',
        entity: 'product',
        entityId: p!.id,
        after: { ...p, eans },
      });
      return { id: p!.id, code: p!.code };
    });
  });

  app.patch(
    '/products/:id',
    { ...editors, schema: { ...idParams, body: productPatchSchema } },
    async (req) => {
      const { updatedAt, eans, ...fields } = req.body;
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(product)
          .where(eq(product.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Produit introuvable.');
        if (before.updatedAt.toISOString() !== new Date(updatedAt).toISOString()) {
          throw conflict('La fiche a été modifiée entre-temps. Rechargez-la avant d’enregistrer.');
        }
        if (fields.code && fields.code !== before.code) {
          // R-PRD-01: the code cannot change once the product has been sold.
          const [sold] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(saleLine)
            .where(eq(saleLine.productId, before.id));
          if (sold!.n > 0) throw conflict('Le code d’un produit déjà vendu ne peut plus changer.');
          if (await tx.query.product.findFirst({ where: eq(product.code, fields.code) }))
            throw conflict(`Le code ${fields.code} est déjà utilisé.`);
        }
        const set: Partial<typeof product.$inferInsert> = { ...fields };
        const excl =
          fields.purchasePriceExcl !== undefined
            ? fields.purchasePriceExcl
            : before.purchasePriceExcl;
        const vat = fields.vatRate ?? before.vatRate;
        if (fields.purchasePriceExcl !== undefined || fields.vatRate !== undefined) {
          set.purchasePriceIncl = excl ? purchasePriceIncl(excl, vat) : null;
        }
        const priceChanged =
          (fields.salePrice !== undefined &&
            Number(fields.salePrice) !== Number(before.salePrice)) ||
          (fields.purchasePriceExcl !== undefined &&
            Number(fields.purchasePriceExcl ?? 0) !== Number(before.purchasePriceExcl ?? 0));
        if (fields.salePrice !== undefined && Number(fields.salePrice) !== Number(before.salePrice))
          set.labelPending = true;
        const [after] = await tx
          .update(product)
          .set(set)
          .where(eq(product.id, before.id))
          .returning();
        if (eans) {
          await assertFreeEans(tx, eans, before.id);
          await tx.delete(productBarcode).where(eq(productBarcode.productId, before.id));
          if (eans.length)
            await tx
              .insert(productBarcode)
              .values(eans.map((ean) => ({ ean, productId: before.id })));
        }
        if (priceChanged) {
          // R-PRD-05: every price change is dated, with its author and origin.
          await tx.insert(priceHistory).values({
            productId: before.id,
            purchasePriceExcl: after!.purchasePriceExcl,
            purchasePriceIncl: after!.purchasePriceIncl,
            salePrice: after!.salePrice,
            source: 'FORM',
            by: req.user!.id,
          });
        }
        const changed = [...Object.keys(set), ...(eans ? ['eans'] : [])] as string[];
        await audit(tx, req, {
          action:
            fields.status && fields.status !== before.status ? 'product.status' : 'product.update',
          entity: 'product',
          entityId: before.id,
          before: Object.fromEntries(
            changed.map((k) => [k, (before as Record<string, unknown>)[k]]),
          ),
          after: {
            ...Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])),
            ...(eans ? { eans } : {}),
          },
        });
        return { id: after!.id, updatedAt: after!.updatedAt.toISOString() };
      });
    },
  );

  /** R-PRD-06: mark labels as printed. */
  app.post(
    '/products/labels/done',
    {
      ...editors,
      schema: { body: z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }) },
    },
    async (req) => {
      await db.transaction(async (tx) => {
        await tx
          .update(product)
          .set({ labelPending: false })
          .where(inArray(product.id, req.body.ids));
        await audit(tx, req, {
          action: 'product.labels_done',
          entity: 'product',
          after: { ids: req.body.ids },
        });
      });
      return { ok: true };
    },
  );

  // --- Images (R-PRD-01, R-VTE-14) ------------------------------------------------------

  app.put('/products/:id/image', { ...editors, schema: idParams }, async (req) => {
    const mime = req.headers['content-type']?.split(';')[0] ?? '';
    if (!IMAGE_TYPES.includes(mime) || !Buffer.isBuffer(req.body))
      throw badRequest('Image PNG, JPEG ou WebP attendue.');
    return db.transaction(async (tx) => {
      const p = await tx.query.product.findFirst({ where: eq(product.id, req.params.id) });
      if (!p) throw notFound('Produit introuvable.');
      const [m] = await tx
        .insert(media)
        .values({ mime, bytes: req.body as Buffer })
        .returning({ id: media.id });
      await tx.update(product).set({ imageId: m!.id }).where(eq(product.id, p.id));
      if (p.imageId) await tx.delete(media).where(eq(media.id, p.imageId));
      await audit(tx, req, { action: 'product.image', entity: 'product', entityId: p.id });
      return { imageId: m!.id };
    });
  });

  /** Media are immutable (a new upload gets a new id), so they are cached for a year. */
  app.get('/media/:id', { schema: idParams }, async (req, reply) => {
    const m = await db.query.media.findFirst({ where: eq(media.id, req.params.id) });
    if (!m) throw notFound('Image introuvable.');
    return reply
      .header('cache-control', 'private, max-age=31536000, immutable')
      .type(m.mime)
      .send(m.bytes);
  });
};

async function nextProductCode(db: Db | Tx, categoryId: string): Promise<string> {
  const [c] = await db
    .select({ code: category.code, universe: universe.code })
    .from(category)
    .innerJoin(universe, eq(universe.id, category.universeId))
    .where(eq(category.id, categoryId));
  if (!c) throw badRequest('Rayon inconnu.');
  const prefix = `${c.universe}${c.code}`;
  if (!/^\d{3}$/.test(prefix))
    throw badRequest('Le rayon n’a pas un code compatible (univers 1 chiffre + rayon 2 chiffres).');
  const [row] = await db
    .select({ max: sql<string | null>`max(${product.code})` })
    .from(product)
    .where(sql`${product.code} ~ ${'^' + prefix + '[0-9]{3}$'}`);
  const next = row?.max ? Number(row.max.slice(3)) + 1 : 1;
  if (next > 999) throw conflict(`Le rayon ${prefix} est plein (999 produits).`);
  return `${prefix}${String(next).padStart(3, '0')}`;
}

async function assertFreeEans(tx: Tx, eans: string[], selfId: string | null) {
  if (!eans.length) return;
  const used = await tx.select().from(productBarcode).where(inArray(productBarcode.ean, eans));
  const clash = used.find((u) => u.productId !== selfId);
  if (clash) throw conflict(`Le code-barres ${clash.ean} est déjà attribué à un autre produit.`);
}
