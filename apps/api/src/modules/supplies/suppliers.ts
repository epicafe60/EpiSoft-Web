import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  goodsReceipt,
  product,
  purchaseOrder,
  supplier,
  supplierInvoice,
  type Db,
} from '@episoft/db';
import { nextSupplierCode, supplierSchema } from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { ensureAccount, nextSupplierAccountNumber } from '../accounting/service';

const idParams = { params: z.object({ id: z.string().uuid() }) };

export const supplierRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const readers = { preHandler: app.requireRoles('APPROS', 'PRODUITS', 'COMPTA') };
  const editors = { preHandler: app.requireRoles('APPROS') };

  app.get(
    '/suppliers',
    {
      ...readers,
      schema: {
        querystring: z.object({
          q: z.string().max(100).optional(),
          active: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (req) => {
      const f: SQL[] = [];
      if (req.query.q)
        f.push(or(ilike(supplier.name, `%${req.query.q}%`), eq(supplier.code, req.query.q))!);
      if (req.query.active) f.push(eq(supplier.active, req.query.active === 'true'));
      return db
        .select({
          id: supplier.id,
          code: supplier.code,
          name: supplier.name,
          contact: supplier.contact,
          email: supplier.email,
          phone: supplier.phone,
          active: supplier.active,
          sendsPo: supplier.sendsPo,
          products: sql<number>`(select count(*)::int from app.product p where p.supplier_id = ${supplier.id} and p.status <> 'INACTIVE')`,
          toPay: sql<string>`(select coalesce(sum(total_incl), 0)::numeric(12,2)::text from app.supplier_invoice i where i.supplier_id = ${supplier.id} and i.status = 'TO_PAY')`,
        })
        .from(supplier)
        .where(and(...f))
        .orderBy(asc(supplier.name));
    },
  );

  app.get(
    '/suppliers/next-code',
    { ...editors, schema: { querystring: z.object({ region: z.string().regex(/^\d{1,2}$/) }) } },
    async (req) => {
      const codes = (await db.select({ code: supplier.code }).from(supplier)).map((s) => s.code);
      return { code: nextSupplierCode(codes, req.query.region) };
    },
  );

  /** R-FNR-03: the supplier with its products, orders and invoices. */
  app.get('/suppliers/:id', { ...readers, schema: idParams }, async (req) => {
    const s = await db.query.supplier.findFirst({ where: eq(supplier.id, req.params.id) });
    if (!s) throw notFound('Fournisseur introuvable.');
    const products = await db
      .select({
        id: product.id,
        code: product.code,
        name: product.name,
        status: product.status,
        stockQty: product.stockQty,
        minStock: product.minStock,
        purchasePriceExcl: product.purchasePriceExcl,
        salePrice: product.salePrice,
        supplierRef: product.supplierRef,
      })
      .from(product)
      .where(eq(product.supplierId, s.id))
      .orderBy(product.name);
    const orders = await db
      .select({
        id: purchaseOrder.id,
        number: purchaseOrder.number,
        date: purchaseOrder.date,
        status: purchaseOrder.status,
        totalIncl: purchaseOrder.totalIncl,
      })
      .from(purchaseOrder)
      .where(eq(purchaseOrder.supplierId, s.id))
      .orderBy(desc(purchaseOrder.date))
      .limit(100);
    const invoices = await db
      .select({
        id: supplierInvoice.id,
        pieceRef: supplierInvoice.pieceRef,
        date: supplierInvoice.date,
        dueDate: supplierInvoice.dueDate,
        totalIncl: supplierInvoice.totalIncl,
        status: supplierInvoice.status,
      })
      .from(supplierInvoice)
      .where(eq(supplierInvoice.supplierId, s.id))
      .orderBy(desc(supplierInvoice.date))
      .limit(100);
    const receipts = await db
      .select({
        id: goodsReceipt.id,
        number: goodsReceipt.number,
        date: goodsReceipt.date,
        orderId: goodsReceipt.orderId,
      })
      .from(goodsReceipt)
      .where(eq(goodsReceipt.supplierId, s.id))
      .orderBy(desc(goodsReceipt.date))
      .limit(100);
    return {
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      products,
      orders,
      invoices,
      receipts,
    };
  });

  app.post('/suppliers', { ...editors, schema: { body: supplierSchema } }, async (req) => {
    const { region, code, ...fields } = req.body;
    return db.transaction(async (tx) => {
      const codes = (await tx.select({ code: supplier.code }).from(supplier)).map((s) => s.code);
      const finalCode = code ?? (region ? nextSupplierCode(codes, region) : null);
      if (!finalCode) throw badRequest('Indiquez la région ou le code du fournisseur.');
      if (codes.includes(finalCode)) throw conflict(`Le code ${finalCode} est déjà utilisé.`);
      const [s] = await tx
        .insert(supplier)
        .values({
          ...fields,
          code: finalCode,
          accountNumber: fields.accountNumber ?? (await nextSupplierAccountNumber(tx)),
        })
        .returning();
      // R-FNR-01: the 401 account is created with the supplier.
      if (s!.accountNumber && /^[0-9]{6}$/.test(s!.accountNumber)) {
        await ensureAccount(tx, s!.accountNumber, s!.name);
      }
      await audit(tx, req, {
        action: 'supplier.create',
        entity: 'supplier',
        entityId: s!.id,
        after: s,
      });
      return { id: s!.id, code: s!.code };
    });
  });

  app.patch(
    '/suppliers/:id',
    {
      ...editors,
      schema: {
        ...idParams,
        body: supplierSchema.partial().extend({ updatedAt: z.string().datetime({ offset: true }) }),
      },
    },
    async (req) => {
      const { updatedAt, region: _region, ...fields } = req.body;
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(supplier)
          .where(eq(supplier.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Fournisseur introuvable.');
        if (before.updatedAt.toISOString() !== new Date(updatedAt).toISOString()) {
          throw conflict('La fiche a été modifiée entre-temps. Rechargez-la avant d’enregistrer.');
        }
        if (fields.code && fields.code !== before.code) {
          const dup = await tx.query.supplier.findFirst({ where: eq(supplier.code, fields.code) });
          if (dup) throw conflict(`Le code ${fields.code} est déjà utilisé.`);
        }
        const [after] = await tx
          .update(supplier)
          .set(fields)
          .where(eq(supplier.id, before.id))
          .returning();
        await audit(tx, req, {
          action: 'supplier.update',
          entity: 'supplier',
          entityId: before.id,
          before,
          after,
        });
        return { id: after!.id, updatedAt: after!.updatedAt.toISOString() };
      });
    },
  );
};
