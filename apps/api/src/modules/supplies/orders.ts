import ExcelJS from 'exceljs';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  goodsReceipt,
  goodsReceiptLine,
  invoiceReceipt,
  member,
  priceHistory,
  product,
  productBatch,
  purchaseOrder,
  purchaseOrderLine,
  supplier,
  supplierInvoice,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  centsToDecimal,
  formatDocNumber,
  inclFromExcl4,
  milliToDecimal,
  orderCreateSchema,
  orderLineTotals,
  orderSchema,
  orderSendSchema,
  orderTotals,
  parsePrice4,
  parseQtyToMilli,
  price4ToDecimal,
  purchasePriceFlag,
  receiptCorrectionSchema,
  receiptSchema,
  suggestedOrderQtyMilli,
  formatQty,
  type Settings,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { parisYear, toParisDate } from '../../lib/dates';
import { escapeHtml, pdfAttachment, queueEmail } from '../../lib/mail';
import { eur, keyValues, letterhead, pdfText, render, table } from '../../lib/pdf';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';
import { nextNumber } from '../pos/numbers';
import { reservedByProduct } from '../preorders/routes';
import { recordMovement } from '../stock/ledger';

const idParams = { params: z.object({ id: z.string().uuid() }) };
export const PO_STATUS_LABELS = {
  DRAFT: 'Brouillon',
  SENT: 'Envoyée',
  PARTIAL: 'Partiellement reçue',
  RECEIVED: 'Reçue',
  CLOSED: 'Soldée',
  CANCELLED: 'Annulée',
} as const;

async function recomputeTotals(tx: Tx, orderId: string) {
  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.orderId, orderId));
  const t = orderTotals(
    lines.map((l) => ({
      qtyMilli: parseQtyToMilli(l.qtyOrdered)!,
      unitPriceExcl4: parsePrice4(l.unitPriceExcl)!,
      vatRate: l.vatRate,
    })),
  );
  await tx
    .update(purchaseOrder)
    .set({
      totalExcl: centsToDecimal(t.exclCents),
      totalVat: centsToDecimal(t.vatCents),
      totalIncl: centsToDecimal(t.inclCents),
    })
    .where(eq(purchaseOrder.id, orderId));
}

/** Replaces the lines of a draft order. R-CMD-02: quantity 0 removes the line. */
async function writeLines(
  tx: Tx,
  orderId: string,
  lines: { productId: string; qty: string; unitPriceExcl: string }[],
) {
  await tx.delete(purchaseOrderLine).where(eq(purchaseOrderLine.orderId, orderId));
  const kept = lines.filter((l) => parseQtyToMilli(l.qty)! > 0);
  if (kept.length) {
    const prods = await tx
      .select({ id: product.id, vatRate: product.vatRate })
      .from(product)
      .where(
        inArray(
          product.id,
          kept.map((l) => l.productId),
        ),
      );
    const vat = new Map(prods.map((p) => [p.id, p.vatRate]));
    await tx.insert(purchaseOrderLine).values(
      kept.map((l, i) => {
        if (!vat.has(l.productId)) throw badRequest('Produit inconnu.');
        return {
          orderId,
          lineNo: i + 1,
          productId: l.productId,
          qtyOrdered: l.qty,
          unitPriceExcl: l.unitPriceExcl,
          vatRate: vat.get(l.productId)!,
        };
      }),
    );
  }
  await recomputeTotals(tx, orderId);
}

export async function orderDetail(db: Db | Tx, id: string) {
  const o = await db.query.purchaseOrder.findFirst({ where: eq(purchaseOrder.id, id) });
  if (!o) return null;
  const s = await db.query.supplier.findFirst({ where: eq(supplier.id, o.supplierId) });
  const lines = await db
    .select({
      id: purchaseOrderLine.id,
      lineNo: purchaseOrderLine.lineNo,
      productId: purchaseOrderLine.productId,
      code: product.code,
      name: product.name,
      supplierRef: product.supplierRef,
      qtyOrdered: purchaseOrderLine.qtyOrdered,
      qtyReceived: purchaseOrderLine.qtyReceived,
      unitPriceExcl: purchaseOrderLine.unitPriceExcl,
      vatRate: purchaseOrderLine.vatRate,
      salePrice: product.salePrice,
      purchasePriceExcl: product.purchasePriceExcl,
      stockQty: product.stockQty,
    })
    .from(purchaseOrderLine)
    .innerJoin(product, eq(product.id, purchaseOrderLine.productId))
    .where(eq(purchaseOrderLine.orderId, id))
    .orderBy(purchaseOrderLine.lineNo);
  const receipts = await db
    .select({
      id: goodsReceipt.id,
      number: goodsReceipt.number,
      date: goodsReceipt.date,
      byFirst: member.firstName,
      byLast: member.lastName,
    })
    .from(goodsReceipt)
    .leftJoin(member, eq(member.id, goodsReceipt.receivedBy))
    .where(eq(goodsReceipt.orderId, id))
    .orderBy(goodsReceipt.date);
  return {
    ...o,
    supplier: s
      ? {
          id: s.id,
          code: s.code,
          name: s.name,
          email: s.email,
          minOrderAmount: s.minOrderAmount,
          street: s.street,
          postcode: s.postcode,
          phone: s.phone,
        }
      : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    sentAt: o.sentAt?.toISOString() ?? null,
    lines: lines.map((l) => {
      const t = orderLineTotals({
        qtyMilli: parseQtyToMilli(l.qtyOrdered)!,
        unitPriceExcl4: parsePrice4(l.unitPriceExcl)!,
        vatRate: l.vatRate,
      });
      return { ...l, totalExcl: centsToDecimal(t.exclCents) };
    }),
    // R-EVO-11: who keyed in the received quantities.
    receipts: receipts.map((r) => ({
      id: r.id,
      number: r.number,
      date: r.date,
      receivedByName: r.byFirst ? `${r.byFirst} ${r.byLast}` : null,
    })),
  };
}

/** R-CMD-03: the purchase order PDF, with coherent HT / VAT / TTC totals. */
export async function orderPdf(db: Db | Tx, id: string): Promise<Buffer> {
  const o = await orderDetail(db, id);
  if (!o) throw notFound('Commande introuvable.');
  const settings = await loadSettings(db);
  return render((doc) => {
    letterhead(doc, settings['association.identity']);
    doc.font('Helvetica-Bold').fontSize(16).text(`Bon de commande ${o.number}`);
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(`Date : ${o.date.split('-').reverse().join('/')}`);
    doc.moveDown(0.5);
    if (o.supplier) {
      doc
        .font('Helvetica-Bold')
        .text(pdfText(`Fournisseur : ${o.supplier.name} (${o.supplier.code})`));
      doc.font('Helvetica');
      for (const l of [o.supplier.street, o.supplier.postcode, o.supplier.phone, o.supplier.email])
        if (l) doc.text(pdfText(l));
    }
    doc.moveDown();
    table(
      doc,
      [
        { header: 'Réf. fournisseur', width: 90 },
        { header: 'Désignation', width: 215 },
        { header: 'Qté', width: 50, align: 'right' },
        { header: 'PA HT', width: 70, align: 'right' },
        { header: 'Total HT', width: 90, align: 'right' },
      ],
      o.lines.map((l) => [
        l.supplierRef ?? '',
        l.name,
        formatQty(parseQtyToMilli(l.qtyOrdered)!),
        eur(l.unitPriceExcl),
        eur(l.totalExcl),
      ]),
    );
    doc.moveDown();
    keyValues(
      doc,
      [
        ['Total HT', eur(o.totalExcl)],
        ['TVA', eur(o.totalVat)],
        ['Total TTC', eur(o.totalIncl)],
      ],
      { x: 305, width: 210, bold: ['Total TTC'] },
    );
    if (o.comment) {
      doc.moveDown();
      doc.fontSize(10).text(pdfText(`Commentaire : ${o.comment}`));
    }
  });
}

export interface ReceiptInput {
  supplierId: string;
  orderId: string | null;
  date: string;
  comment: string | null;
  lines: {
    orderLineId: string | null;
    productId: string;
    qty: string;
    unitPriceExcl: string;
    bestBefore?: string | null;
  }[];
  closeOrder: boolean;
  newSalePrices: Record<string, string>;
}

/**
 * R-CMD-05: a receipt and, in the same transaction, the PURCHASE_IN movements (stock is
 * incremented, never overwritten), the purchase prices and the accepted selling prices.
 */
export async function recordReceipt(
  tx: Tx,
  input: ReceiptInput,
  by: string,
): Promise<{ id: string; number: string; warnings: string[] }> {
  const thresholds = (await loadSettings(tx))['controls.thresholds'];
  const warnings: string[] = [];
  const year = parisYear(new Date(`${input.date}T12:00:00Z`));
  const number = formatDocNumber('RC', year, await nextNumber(tx, `receipt:${year}`));
  const [r] = await tx
    .insert(goodsReceipt)
    .values({
      number,
      orderId: input.orderId,
      supplierId: input.supplierId,
      date: input.date,
      receivedBy: by,
      comment: input.comment,
    })
    .returning();
  const prods = await tx
    .select()
    .from(product)
    .where(
      inArray(
        product.id,
        input.lines.map((l) => l.productId),
      ),
    );
  const byId = new Map(prods.map((p) => [p.id, p]));
  for (const [i, l] of input.lines.entries()) {
    const p = byId.get(l.productId);
    if (!p) throw badRequest('Produit inconnu.');
    // The purchase price is about to be replaced: say so when it jumps, or when it is 0.
    const nextPrice4 = parsePrice4(l.unitPriceExcl)!;
    if (nextPrice4 === 0) warnings.push(`${p.name} : prix d’achat à 0 €.`);
    const flag = purchasePriceFlag(
      p.purchasePriceExcl === null ? null : parsePrice4(p.purchasePriceExcl),
      nextPrice4,
      thresholds,
    );
    if (flag.flagged)
      warnings.push(
        `${p.name} : prix d’achat ${p.purchasePriceExcl} → ${l.unitPriceExcl} (${flag.pct! > 0 ? '+' : ''}${Math.round(flag.pct!)} %).`,
      );
    if (l.orderLineId) {
      const [ol] = await tx
        .select()
        .from(purchaseOrderLine)
        .where(eq(purchaseOrderLine.id, l.orderLineId));
      if (!ol || ol.orderId !== input.orderId || ol.productId !== l.productId)
        throw badRequest('Ligne de commande incohérente.');
      if (
        parseQtyToMilli(ol.qtyReceived)! + parseQtyToMilli(l.qty)! >
        parseQtyToMilli(ol.qtyOrdered)!
      )
        warnings.push(`${p.name} : reçu plus que commandé (${ol.qtyOrdered} commandé).`);
      await tx
        .update(purchaseOrderLine)
        .set({ qtyReceived: sql`${purchaseOrderLine.qtyReceived} + ${l.qty}::numeric` })
        .where(eq(purchaseOrderLine.id, l.orderLineId));
    }
    await tx.insert(goodsReceiptLine).values({
      receiptId: r!.id,
      lineNo: i + 1,
      productId: p.id,
      qty: l.qty,
      unitPriceExcl: l.unitPriceExcl,
      vatRate: p.vatRate,
      orderLineId: l.orderLineId,
    });
    if (p.kind === 'GOODS' && l.bestBefore)
      await tx.insert(productBatch).values({
        productId: p.id,
        bestBefore: l.bestBefore,
        qty: l.qty,
        note: `Réception ${number}`,
        by,
      });
    if (p.kind === 'GOODS') {
      await recordMovement(tx, {
        productId: p.id,
        qtyMilli: parseQtyToMilli(l.qty)!,
        kind: 'PURCHASE_IN',
        unitCost: l.unitPriceExcl,
        sourceType: 'receipt',
        sourceId: r!.id,
        by,
      });
    }
    // Purchase price and accepted selling price (R-PRD-05 history, R-PRD-06 labels).
    const excl = parsePrice4(l.unitPriceExcl)!;
    const newSale = input.newSalePrices[p.id];
    const paChanged = excl !== parsePrice4(p.purchasePriceExcl ?? '0');
    const pvChanged = newSale !== undefined && newSale !== p.salePrice;
    if (paChanged || pvChanged) {
      const incl = price4ToDecimal(inclFromExcl4(excl, p.vatRate));
      const [after] = await tx
        .update(product)
        .set({
          purchasePriceExcl: l.unitPriceExcl,
          purchasePriceIncl: incl,
          ...(pvChanged ? { salePrice: newSale, labelPending: true } : {}),
        })
        .where(eq(product.id, p.id))
        .returning();
      await tx.insert(priceHistory).values({
        productId: p.id,
        purchasePriceExcl: after!.purchasePriceExcl,
        purchasePriceIncl: after!.purchasePriceIncl,
        salePrice: after!.salePrice,
        source: 'RECEIPT',
        by,
      });
    }
  }
  if (input.orderId) {
    const lines = await tx
      .select()
      .from(purchaseOrderLine)
      .where(eq(purchaseOrderLine.orderId, input.orderId));
    const complete = lines.every(
      (ol) => parseQtyToMilli(ol.qtyReceived)! >= parseQtyToMilli(ol.qtyOrdered)!,
    );
    const status = input.closeOrder ? 'CLOSED' : complete ? 'RECEIVED' : 'PARTIAL';
    await tx.update(purchaseOrder).set({ status }).where(eq(purchaseOrder.id, input.orderId));
  }
  return { id: r!.id, number, warnings };
}

export const orderRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const appros = { preHandler: app.requireRoles('APPROS') };
  const readers = { preHandler: app.requireRoles('APPROS', 'COMPTA') };

  const listQuery = z.object({
    supplierId: z.string().uuid().optional(),
    status: z.enum(['DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED']).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  });
  const listOrders = async (q: z.infer<typeof listQuery>) => {
    const f: SQL[] = [];
    if (q.supplierId) f.push(eq(purchaseOrder.supplierId, q.supplierId));
    if (q.status) f.push(eq(purchaseOrder.status, q.status));
    if (q.from) f.push(gte(purchaseOrder.date, q.from));
    if (q.to) f.push(lte(purchaseOrder.date, q.to));
    return db
      .select({
        id: purchaseOrder.id,
        number: purchaseOrder.number,
        date: purchaseOrder.date,
        status: purchaseOrder.status,
        supplierId: purchaseOrder.supplierId,
        supplierName: supplier.name,
        totalExcl: purchaseOrder.totalExcl,
        totalVat: purchaseOrder.totalVat,
        totalIncl: purchaseOrder.totalIncl,
        comment: purchaseOrder.comment,
      })
      .from(purchaseOrder)
      .innerJoin(supplier, eq(supplier.id, purchaseOrder.supplierId))
      .where(and(...f))
      .orderBy(desc(purchaseOrder.date), desc(purchaseOrder.number))
      .limit(1000);
  };

  /** R-CMD-08: filterable list with totals. */
  app.get('/purchase-orders', { ...readers, schema: { querystring: listQuery } }, async (req) =>
    listOrders(req.query),
  );

  app.get(
    '/purchase-orders.xlsx',
    { ...readers, schema: { querystring: listQuery } },
    async (req, reply) => {
      const rows = await listOrders(req.query);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Commandes');
      ws.columns = [
        { header: 'N°', key: 'number', width: 16 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Fournisseur', key: 'supplierName', width: 32 },
        { header: 'État', key: 'status', width: 20 },
        { header: 'Total HT', key: 'totalExcl', width: 12, style: { numFmt: '#,##0.00 €' } },
        { header: 'TVA', key: 'totalVat', width: 10, style: { numFmt: '#,##0.00 €' } },
        { header: 'Total TTC', key: 'totalIncl', width: 12, style: { numFmt: '#,##0.00 €' } },
      ];
      ws.getRow(1).font = { bold: true };
      for (const r of rows)
        ws.addRow({
          ...r,
          status: PO_STATUS_LABELS[r.status],
          totalExcl: Number(r.totalExcl),
          totalVat: Number(r.totalVat),
          totalIncl: Number(r.totalIncl),
        });
      const buf = await wb.xlsx.writeBuffer();
      return reply
        .header('content-disposition', 'attachment; filename="commandes.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(Buffer.from(buf));
    },
  );

  /** R-CMD-01: a new order is prefilled with the supplier's active products to reorder. */
  app.post('/purchase-orders', { ...appros, schema: { body: orderCreateSchema } }, async (req) => {
    const b = req.body;
    return db.transaction(async (tx) => {
      const s = await tx.query.supplier.findFirst({ where: eq(supplier.id, b.supplierId) });
      if (!s) throw notFound('Fournisseur introuvable.');
      const date = b.date ?? toParisDate(new Date());
      const year = Number(date.slice(0, 4));
      const number = formatDocNumber('CF', year, await nextNumber(tx, `po:${year}`));
      const [o] = await tx
        .insert(purchaseOrder)
        .values({
          number,
          supplierId: s.id,
          date,
          comment: b.comment ?? null,
          createdBy: req.user!.id,
        })
        .returning();
      let lines = b.lines;
      if (!lines) {
        const prods = await tx
          .select()
          .from(product)
          .where(
            and(
              eq(product.supplierId, s.id),
              inArray(product.status, ['ACTIVE', 'ON_ORDER']),
              eq(product.kind, 'GOODS'),
            ),
          )
          .orderBy(asc(product.name));
        // R-PRE-02: what customers have pre-ordered is added to the suggestion.
        const reserved = await reservedByProduct(
          tx,
          prods.map((p) => p.id),
        );
        lines = prods
          .map((p) => ({
            productId: p.id,
            qty: milliToDecimal(
              suggestedOrderQtyMilli(
                p.minStock === null ? null : parseQtyToMilli(p.minStock),
                parseQtyToMilli(p.stockQty)!,
                reserved.get(p.id) ?? 0,
              ),
            ),
            unitPriceExcl: p.purchasePriceExcl ?? '0',
          }))
          .filter((l) => l.qty !== '0.000');
      }
      await writeLines(tx, o!.id, lines);
      await audit(tx, req, {
        action: 'order.create',
        entity: 'purchase_order',
        entityId: o!.id,
        after: { number, supplier: s.code },
      });
      return { id: o!.id, number };
    });
  });

  app.get('/purchase-orders/:id', { ...readers, schema: idParams }, async (req) => {
    const o = await orderDetail(db, req.params.id);
    if (!o) throw notFound('Commande introuvable.');
    return o;
  });

  /**
   * R-EVO-10: every active reference of the order's supplier, with its stock, minimum stock and
   * the suggested quantity, to order from the full list and not only from what is under the minimum.
   */
  app.get(
    '/purchase-orders/:id/supplier-products',
    { ...readers, schema: idParams },
    async (req) => {
      const [o] = await db.select().from(purchaseOrder).where(eq(purchaseOrder.id, req.params.id));
      if (!o) throw notFound('Commande introuvable.');
      const prods = await db
        .select()
        .from(product)
        .where(
          and(
            eq(product.supplierId, o.supplierId),
            inArray(product.status, ['ACTIVE', 'ON_ORDER']),
            eq(product.kind, 'GOODS'),
          ),
        )
        .orderBy(asc(product.name));
      const reserved = await reservedByProduct(
        db,
        prods.map((p) => p.id),
      );
      return prods.map((p) => ({
        productId: p.id,
        code: p.code,
        name: p.name,
        unit: p.unit,
        stockQty: p.stockQty,
        minStock: p.minStock,
        purchasePriceExcl: p.purchasePriceExcl ?? '0',
        vatRate: p.vatRate,
        suggestedQty: milliToDecimal(
          suggestedOrderQtyMilli(
            p.minStock === null ? null : parseQtyToMilli(p.minStock),
            parseQtyToMilli(p.stockQty)!,
            reserved.get(p.id) ?? 0,
          ),
        ),
      }));
    },
  );

  /** Lines, date and comment of a draft (R-CMD-02, R-CMD-07). */
  app.put(
    '/purchase-orders/:id',
    { ...appros, schema: { ...idParams, body: orderSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [o] = await tx
          .select()
          .from(purchaseOrder)
          .where(eq(purchaseOrder.id, req.params.id))
          .for('update');
        if (!o) throw notFound('Commande introuvable.');
        if (o.status !== 'DRAFT') throw conflict('Seule une commande en brouillon est modifiable.');
        await tx
          .update(purchaseOrder)
          .set({
            ...(req.body.date ? { date: req.body.date } : {}),
            ...(req.body.comment !== undefined ? { comment: req.body.comment } : {}),
          })
          .where(eq(purchaseOrder.id, o.id));
        await writeLines(tx, o.id, req.body.lines);
        await audit(tx, req, {
          action: 'order.update',
          entity: 'purchase_order',
          entityId: o.id,
          after: { lines: req.body.lines.length },
        });
        return orderDetail(tx, o.id);
      }),
  );

  app.delete('/purchase-orders/:id', { ...appros, schema: idParams }, async (req, reply) => {
    await db.transaction(async (tx) => {
      const [o] = await tx
        .select()
        .from(purchaseOrder)
        .where(eq(purchaseOrder.id, req.params.id))
        .for('update');
      if (!o) throw notFound('Commande introuvable.');
      // R-EVO-12: a cancelled order (never received) can be deleted too.
      if (o.status !== 'DRAFT' && o.status !== 'CANCELLED')
        throw conflict('Seule une commande en brouillon ou annulée peut être supprimée.');
      await tx.delete(purchaseOrder).where(eq(purchaseOrder.id, o.id));
      await audit(tx, req, {
        action: 'order.delete',
        entity: 'purchase_order',
        entityId: o.id,
        before: { number: o.number },
      });
    });
    return reply.status(204).send();
  });

  app.post('/purchase-orders/:id/cancel', { ...appros, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [o] = await tx
        .select()
        .from(purchaseOrder)
        .where(eq(purchaseOrder.id, req.params.id))
        .for('update');
      if (!o) throw notFound('Commande introuvable.');
      if (o.status !== 'DRAFT' && o.status !== 'SENT')
        throw conflict('Une commande déjà reçue ne peut pas être annulée.');
      await tx.update(purchaseOrder).set({ status: 'CANCELLED' }).where(eq(purchaseOrder.id, o.id));
      await audit(tx, req, { action: 'order.cancel', entity: 'purchase_order', entityId: o.id });
      return { ok: true };
    }),
  );

  app.get('/purchase-orders/:id/pdf', { ...readers, schema: idParams }, async (req, reply) => {
    const pdf = await orderPdf(db, req.params.id);
    const o = await db.query.purchaseOrder.findFirst({
      where: eq(purchaseOrder.id, req.params.id),
      columns: { number: true },
    });
    return reply
      .header('content-disposition', `inline; filename="${o!.number}.pdf"`)
      .type('application/pdf')
      .send(pdf);
  });

  /** R-CMD-04: e-mailed with the PDF attached; the order becomes "sent". */
  app.post(
    '/purchase-orders/:id/send',
    { ...appros, schema: { ...idParams, body: orderSendSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [o] = await tx
          .select()
          .from(purchaseOrder)
          .where(eq(purchaseOrder.id, req.params.id))
          .for('update');
        if (!o) throw notFound('Commande introuvable.');
        if (o.status !== 'DRAFT' && o.status !== 'SENT')
          throw conflict('Cette commande n’est plus à envoyer.');
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(purchaseOrderLine)
          .where(eq(purchaseOrderLine.orderId, o.id))) as [{ n: number }];
        if (!n) throw badRequest('La commande est vide.');
        const pdf = await orderPdf(tx, o.id);
        await queueEmail(tx, {
          to: req.body.to,
          subject: req.body.subject,
          text: req.body.message,
          html: `<div style="font-family:system-ui,sans-serif;white-space:pre-line">${escapeHtml(req.body.message)}</div>`,
          attachments: [pdfAttachment(`${o.number}.pdf`, pdf)],
        });
        await tx
          .update(purchaseOrder)
          .set({ status: 'SENT', sentAt: new Date(), sentTo: req.body.to })
          .where(eq(purchaseOrder.id, o.id));
        await audit(tx, req, {
          action: 'order.send',
          entity: 'purchase_order',
          entityId: o.id,
          after: { to: req.body.to },
        });
        return { ok: true };
      }),
  );

  /** R-CMD-05/06: receive all or part of an order. */
  app.post(
    '/purchase-orders/:id/receipts',
    { ...appros, schema: { ...idParams, body: receiptSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [o] = await tx
          .select()
          .from(purchaseOrder)
          .where(eq(purchaseOrder.id, req.params.id))
          .for('update');
        if (!o) throw notFound('Commande introuvable.');
        if (!['SENT', 'PARTIAL', 'DRAFT'].includes(o.status))
          throw conflict('Cette commande ne peut plus être réceptionnée.');
        const r = await recordReceipt(
          tx,
          {
            supplierId: o.supplierId,
            orderId: o.id,
            date: req.body.date ?? toParisDate(new Date()),
            comment: req.body.comment ?? null,
            lines: req.body.lines,
            closeOrder: req.body.closeOrder,
            newSalePrices: req.body.newSalePrices,
          },
          req.user!.id,
        );
        await audit(tx, req, {
          action: 'receipt.create',
          entity: 'purchase_order',
          entityId: o.id,
          after: {
            receipt: r.number,
            lines: req.body.lines.length,
            close: req.body.closeOrder,
            warnings: r.warnings,
          },
        });
        return r;
      }),
  );

  /** R-CMD-06: close an order without waiting for the remaining quantities. */
  app.post('/purchase-orders/:id/close', { ...appros, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [o] = await tx
        .select()
        .from(purchaseOrder)
        .where(eq(purchaseOrder.id, req.params.id))
        .for('update');
      if (!o) throw notFound('Commande introuvable.');
      if (o.status !== 'PARTIAL' && o.status !== 'SENT')
        throw conflict('Seule une commande envoyée ou partiellement reçue peut être soldée.');
      await tx.update(purchaseOrder).set({ status: 'CLOSED' }).where(eq(purchaseOrder.id, o.id));
      await audit(tx, req, { action: 'order.close', entity: 'purchase_order', entityId: o.id });
      return { ok: true };
    }),
  );

  /** A receipt without an order (direct delivery). */
  app.post(
    '/receipts',
    { ...appros, schema: { body: receiptSchema.extend({ supplierId: z.string().uuid() }) } },
    async (req) =>
      db.transaction(async (tx) => {
        if (req.body.lines.some((l) => l.orderLineId))
          throw badRequest('Réception hors commande : pas de ligne de commande.');
        const r = await recordReceipt(
          tx,
          {
            supplierId: req.body.supplierId,
            orderId: null,
            date: req.body.date ?? toParisDate(new Date()),
            comment: req.body.comment ?? null,
            lines: req.body.lines,
            closeOrder: false,
            newSalePrices: req.body.newSalePrices,
          },
          req.user!.id,
        );
        await audit(tx, req, {
          action: 'receipt.create',
          entity: 'supplier',
          entityId: req.body.supplierId,
          after: { receipt: r.number, warnings: r.warnings },
        });
        return r;
      }),
  );

  /**
   * R-EVO-11: a manager corrects the quantities and prices of a validated receipt. The stock
   * follows through a CORRECTION movement, the order lines are recounted, the change is audited.
   * Refused once an invoice that includes this receipt is paid.
   */
  app.post(
    '/receipts/:id/correct',
    { ...appros, schema: { ...idParams, body: receiptCorrectionSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [r] = await tx
          .select()
          .from(goodsReceipt)
          .where(eq(goodsReceipt.id, req.params.id))
          .for('update');
        if (!r) throw notFound('Réception introuvable.');
        const [paid] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(invoiceReceipt)
          .innerJoin(supplierInvoice, eq(supplierInvoice.id, invoiceReceipt.invoiceId))
          .where(and(eq(invoiceReceipt.receiptId, r.id), eq(supplierInvoice.status, 'PAID')));
        if (paid!.n > 0)
          throw conflict('Une facture réglée inclut cette réception : elle n’est plus modifiable.');
        const lines = await tx
          .select()
          .from(goodsReceiptLine)
          .where(eq(goodsReceiptLine.receiptId, r.id));
        const changes: { lineId: string; before: object; after: object }[] = [];
        for (const c of req.body.lines) {
          const l = lines.find((x) => x.id === c.lineId);
          if (!l) throw badRequest('Ligne de réception inconnue.');
          const deltaMilli = parseQtyToMilli(c.qty)! - parseQtyToMilli(l.qty)!;
          const priceChanged = parsePrice4(c.unitPriceExcl) !== parsePrice4(l.unitPriceExcl);
          if (deltaMilli === 0 && !priceChanged) continue;
          const [p] = await tx.select().from(product).where(eq(product.id, l.productId));
          if (!p) throw badRequest('Produit inconnu.');
          await tx
            .update(goodsReceiptLine)
            .set({ qty: c.qty, unitPriceExcl: c.unitPriceExcl })
            .where(eq(goodsReceiptLine.id, l.id));
          if (p.kind === 'GOODS' && deltaMilli !== 0)
            await recordMovement(tx, {
              productId: p.id,
              qtyMilli: deltaMilli,
              kind: 'CORRECTION',
              unitCost: c.unitPriceExcl,
              sourceType: 'receipt',
              sourceId: r.id,
              comment: `Correction de la réception ${r.number}`,
              by: req.user!.id,
            });
          if (l.orderLineId && deltaMilli !== 0)
            await tx
              .update(purchaseOrderLine)
              .set({
                qtyReceived: sql`${purchaseOrderLine.qtyReceived} + ${milliToDecimal(deltaMilli)}::numeric`,
              })
              .where(eq(purchaseOrderLine.id, l.orderLineId));
          // The purchase price of the product follows if nothing changed it since the receipt.
          if (
            priceChanged &&
            parsePrice4(p.purchasePriceExcl ?? '0') === parsePrice4(l.unitPriceExcl)
          ) {
            const incl = price4ToDecimal(inclFromExcl4(parsePrice4(c.unitPriceExcl)!, p.vatRate));
            const [after] = await tx
              .update(product)
              .set({ purchasePriceExcl: c.unitPriceExcl, purchasePriceIncl: incl })
              .where(eq(product.id, p.id))
              .returning();
            await tx.insert(priceHistory).values({
              productId: p.id,
              purchasePriceExcl: after!.purchasePriceExcl,
              purchasePriceIncl: after!.purchasePriceIncl,
              salePrice: after!.salePrice,
              source: 'RECEIPT',
              by: req.user!.id,
            });
          }
          changes.push({
            lineId: l.id,
            before: { qty: l.qty, unitPriceExcl: l.unitPriceExcl },
            after: { qty: c.qty, unitPriceExcl: c.unitPriceExcl },
          });
        }
        if (r.orderId) {
          const [o] = await tx.select().from(purchaseOrder).where(eq(purchaseOrder.id, r.orderId));
          if (o && (o.status === 'PARTIAL' || o.status === 'RECEIVED')) {
            const ols = await tx
              .select()
              .from(purchaseOrderLine)
              .where(eq(purchaseOrderLine.orderId, o.id));
            const complete = ols.every(
              (ol) => parseQtyToMilli(ol.qtyReceived)! >= parseQtyToMilli(ol.qtyOrdered)!,
            );
            await tx
              .update(purchaseOrder)
              .set({ status: complete ? 'RECEIVED' : 'PARTIAL' })
              .where(eq(purchaseOrder.id, o.id));
          }
        }
        await audit(tx, req, {
          action: 'receipt.correct',
          entity: 'goods_receipt',
          entityId: r.id,
          after: { number: r.number, comment: req.body.comment ?? null, changes },
        });
        return { id: r.id, changed: changes.length };
      }),
  );

  app.get('/receipts/:id', { ...readers, schema: idParams }, async (req) => {
    const r = await db.query.goodsReceipt.findFirst({ where: eq(goodsReceipt.id, req.params.id) });
    if (!r) throw notFound('Réception introuvable.');
    const lines = await db
      .select({
        id: goodsReceiptLine.id,
        productId: goodsReceiptLine.productId,
        name: product.name,
        code: product.code,
        qty: goodsReceiptLine.qty,
        unitPriceExcl: goodsReceiptLine.unitPriceExcl,
        vatRate: goodsReceiptLine.vatRate,
      })
      .from(goodsReceiptLine)
      .innerJoin(product, eq(product.id, goodsReceiptLine.productId))
      .where(eq(goodsReceiptLine.receiptId, r.id))
      .orderBy(goodsReceiptLine.lineNo);
    const t = orderTotals(
      lines.map((l) => ({
        qtyMilli: parseQtyToMilli(l.qty)!,
        unitPriceExcl4: parsePrice4(l.unitPriceExcl)!,
        vatRate: l.vatRate,
      })),
    );
    // R-EVO-11: who keyed the quantities in.
    const by = r.receivedBy
      ? await db.query.member.findFirst({
          where: eq(member.id, r.receivedBy),
          columns: { firstName: true, lastName: true },
        })
      : null;
    return {
      ...r,
      receivedByName: by ? `${by.firstName} ${by.lastName}` : null,
      createdAt: r.createdAt.toISOString(),
      lines,
      totalExcl: centsToDecimal(t.exclCents),
      totalVat: centsToDecimal(t.vatCents),
      totalIncl: centsToDecimal(t.inclCents),
    };
  });

  /** Pricing rules for the receipt screen (R-CMD-05 suggested price, R-PRD-03). */
  app.get(
    '/catalog/pricing',
    { preHandler: app.requireRoles('APPROS', 'PRODUITS') },
    async (): Promise<Settings['catalog.pricing']> => (await loadSettings(db))['catalog.pricing'],
  );
};
