import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  goodsReceipt,
  goodsReceiptLine,
  invoiceReceipt,
  media,
  supplier,
  supplierInvoice,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  addDays,
  centsToDecimal,
  decimalToCents,
  invoicePaySchema,
  invoiceDueDate,
  invoiceSchema,
  orderTotals,
  parsePrice4,
  parseQtyToMilli,
  probableDuplicates,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toParisDate } from '../../lib/dates';
import { escapeHtml, queueEmail } from '../../lib/mail';
import { payInvoice, syncInvoiceEntry } from '../accounting/auto';
import { eur } from '../../lib/pdf';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';

const idParams = { params: z.object({ id: z.string().uuid() }) };
const DOC_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_DOC_BYTES = 10 * 1024 * 1024;

/** Received amount (TTC) of a set of receipts, to compare with the invoice (R-FAC-02). */
async function receivedTotalCents(db: Db | Tx, receiptIds: string[]): Promise<number> {
  if (!receiptIds.length) return 0;
  const lines = await db
    .select()
    .from(goodsReceiptLine)
    .where(inArray(goodsReceiptLine.receiptId, receiptIds));
  return orderTotals(
    lines.map((l) => ({
      qtyMilli: parseQtyToMilli(l.qty)!,
      unitPriceExcl4: parsePrice4(l.unitPriceExcl)!,
      vatRate: l.vatRate,
    })),
  ).inclCents;
}

async function duplicatesOf(
  db: Db | Tx,
  inv: { id?: string; supplierId: string; pieceRef: string; date: string; totalIncl: string },
) {
  const around = await db
    .select({
      id: supplierInvoice.id,
      supplierId: supplierInvoice.supplierId,
      pieceRef: supplierInvoice.pieceRef,
      date: supplierInvoice.date,
      totalIncl: supplierInvoice.totalIncl,
    })
    .from(supplierInvoice)
    .where(eq(supplierInvoice.supplierId, inv.supplierId));
  return probableDuplicates(inv, around);
}

export const invoiceRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const editors = { preHandler: app.requireRoles('APPROS', 'COMPTA') };

  app.addContentTypeParser(
    DOC_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_DOC_BYTES },
    (_req, body, done) => done(null, body),
  );

  const listQuery = z.object({
    supplierId: z.string().uuid().optional(),
    status: z.enum(['TO_PAY', 'PAID']).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  });

  app.get('/supplier-invoices', { ...editors, schema: { querystring: listQuery } }, async (req) => {
    const q = req.query;
    const f: SQL[] = [];
    if (q.supplierId) f.push(eq(supplierInvoice.supplierId, q.supplierId));
    if (q.status) f.push(eq(supplierInvoice.status, q.status));
    if (q.from) f.push(gte(supplierInvoice.date, q.from));
    if (q.to) f.push(lte(supplierInvoice.date, q.to));
    return db
      .select({
        id: supplierInvoice.id,
        supplierId: supplierInvoice.supplierId,
        supplierName: supplier.name,
        pieceRef: supplierInvoice.pieceRef,
        date: supplierInvoice.date,
        dueDate: supplierInvoice.dueDate,
        totalExcl: supplierInvoice.totalExcl,
        totalVat: supplierInvoice.totalVat,
        totalIncl: supplierInvoice.totalIncl,
        status: supplierInvoice.status,
        paymentMethod: supplierInvoice.paymentMethod,
        paidAt: supplierInvoice.paidAt,
        hasDocument: sql<boolean>`${supplierInvoice.documentMediaId} is not null`,
      })
      .from(supplierInvoice)
      .innerJoin(supplier, eq(supplier.id, supplierInvoice.supplierId))
      .where(and(...f))
      .orderBy(desc(supplierInvoice.date))
      .limit(1000);
  });

  /** R-FAC-05: invoices to pay, by due date. */
  app.get('/supplier-invoices/schedule', editors, async () =>
    db
      .select({
        id: supplierInvoice.id,
        supplierName: supplier.name,
        pieceRef: supplierInvoice.pieceRef,
        date: supplierInvoice.date,
        dueDate: supplierInvoice.dueDate,
        totalIncl: supplierInvoice.totalIncl,
        paymentMethod: supplierInvoice.paymentMethod,
      })
      .from(supplierInvoice)
      .innerJoin(supplier, eq(supplier.id, supplierInvoice.supplierId))
      .where(eq(supplierInvoice.status, 'TO_PAY'))
      .orderBy(asc(supplierInvoice.dueDate)),
  );

  /** R-FAC-05: probable duplicates, checked before saving. */
  app.post(
    '/supplier-invoices/check',
    {
      ...editors,
      schema: {
        body: z.object({
          id: z.string().uuid().optional(),
          supplierId: z.string().uuid(),
          pieceRef: z.string(),
          date: z.string().date(),
          totalIncl: z.string(),
        }),
      },
    },
    async (req) => ({ duplicates: await duplicatesOf(db, req.body) }),
  );

  app.get('/supplier-invoices/:id', { ...editors, schema: idParams }, async (req) => {
    const inv = await db.query.supplierInvoice.findFirst({
      where: eq(supplierInvoice.id, req.params.id),
    });
    if (!inv) throw notFound('Facture introuvable.');
    const links = await db
      .select({ id: goodsReceipt.id, number: goodsReceipt.number, date: goodsReceipt.date })
      .from(invoiceReceipt)
      .innerJoin(goodsReceipt, eq(goodsReceipt.id, invoiceReceipt.receiptId))
      .where(eq(invoiceReceipt.invoiceId, inv.id));
    const received = await receivedTotalCents(
      db,
      links.map((l) => l.id),
    );
    return {
      ...inv,
      createdAt: inv.createdAt.toISOString(),
      updatedAt: inv.updatedAt.toISOString(),
      dueReminderSentAt: inv.dueReminderSentAt?.toISOString() ?? null,
      receipts: links,
      receivedTotal: centsToDecimal(received),
      difference: links.length ? centsToDecimal(decimalToCents(inv.totalIncl) - received) : null,
      duplicates: await duplicatesOf(db, inv),
    };
  });

  const save = async (
    tx: Tx,
    id: string | null,
    b: z.infer<typeof invoiceSchema>,
    userId: string,
  ) => {
    const s = await tx.query.supplier.findFirst({ where: eq(supplier.id, b.supplierId) });
    if (!s) throw badRequest('Fournisseur inconnu.');
    const totalIncl = centsToDecimal(decimalToCents(b.totalExcl) + decimalToCents(b.totalVat));
    const dueDate = b.dueDate ?? invoiceDueDate(b.date, s.paymentTermsDays);
    if (dueDate < b.date) throw badRequest('L’échéance doit suivre la date de facture.');
    const dup = await tx.query.supplierInvoice.findFirst({
      where: and(
        eq(supplierInvoice.supplierId, s.id),
        eq(supplierInvoice.pieceRef, b.pieceRef),
        id ? sql`${supplierInvoice.id} <> ${id}` : undefined,
      ),
    });
    if (dup) throw conflict(`La pièce ${b.pieceRef} de ce fournisseur est déjà enregistrée.`);
    if (b.receiptIds.length) {
      const rs = await tx.select().from(goodsReceipt).where(inArray(goodsReceipt.id, b.receiptIds));
      if (rs.length !== b.receiptIds.length || rs.some((r) => r.supplierId !== s.id))
        throw badRequest('Réception d’un autre fournisseur.');
    }
    const values = {
      supplierId: s.id,
      pieceRef: b.pieceRef,
      date: b.date,
      dueDate,
      totalExcl: b.totalExcl,
      totalVat: b.totalVat,
      totalIncl,
      paymentMethod: b.paymentMethod,
      comment: b.comment,
    };
    const [inv] = id
      ? await tx.update(supplierInvoice).set(values).where(eq(supplierInvoice.id, id)).returning()
      : await tx
          .insert(supplierInvoice)
          .values({ ...values, createdBy: userId })
          .returning();
    await tx.delete(invoiceReceipt).where(eq(invoiceReceipt.invoiceId, inv!.id));
    if (b.receiptIds.length)
      await tx
        .insert(invoiceReceipt)
        .values(b.receiptIds.map((receiptId) => ({ invoiceId: inv!.id, receiptId })));
    return inv!;
  };

  app.post('/supplier-invoices', { ...editors, schema: { body: invoiceSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const inv = await save(tx, null, req.body, req.user!.id);
      await syncInvoiceEntry(tx, inv.id, req.user!.id);
      await audit(tx, req, {
        action: 'invoice.create',
        entity: 'supplier_invoice',
        entityId: inv.id,
        after: inv,
      });
      return { id: inv.id, duplicates: await duplicatesOf(tx, inv) };
    }),
  );

  app.put(
    '/supplier-invoices/:id',
    { ...editors, schema: { ...idParams, body: invoiceSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(supplierInvoice)
          .where(eq(supplierInvoice.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Facture introuvable.');
        if (before.status === 'PAID') throw conflict('Une facture réglée n’est plus modifiable.');
        const inv = await save(tx, before.id, req.body, req.user!.id);
        await syncInvoiceEntry(tx, inv.id, req.user!.id);
        await audit(tx, req, {
          action: 'invoice.update',
          entity: 'supplier_invoice',
          entityId: inv.id,
          before,
          after: inv,
        });
        return { id: inv.id };
      }),
  );

  /** R-FAC-01 [nouveau]: the invoice document is stored by the application. */
  app.put('/supplier-invoices/:id/document', { ...editors, schema: idParams }, async (req) => {
    const mime = req.headers['content-type']?.split(';')[0] ?? '';
    if (!DOC_TYPES.includes(mime) || !Buffer.isBuffer(req.body))
      throw badRequest('Document PDF ou photo attendu.');
    return db.transaction(async (tx) => {
      const inv = await tx.query.supplierInvoice.findFirst({
        where: eq(supplierInvoice.id, req.params.id),
      });
      if (!inv) throw notFound('Facture introuvable.');
      const [m] = await tx
        .insert(media)
        .values({ mime, bytes: req.body as Buffer })
        .returning({ id: media.id });
      await tx
        .update(supplierInvoice)
        .set({ documentMediaId: m!.id })
        .where(eq(supplierInvoice.id, inv.id));
      if (inv.documentMediaId) await tx.delete(media).where(eq(media.id, inv.documentMediaId));
      await audit(tx, req, {
        action: 'invoice.document',
        entity: 'supplier_invoice',
        entityId: inv.id,
      });
      return { documentId: m!.id };
    });
  });

  /** R-FAC-04: payment, with its accounting entry lettered with the invoice entry. */
  app.post(
    '/supplier-invoices/:id/pay',
    { ...editors, schema: { ...idParams, body: invoicePaySchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const r = await payInvoice(tx, {
          invoiceId: req.params.id,
          date: req.body.date,
          method: req.body.method,
          userId: req.user!.id,
        });
        await audit(tx, req, {
          action: 'invoice.pay',
          entity: 'supplier_invoice',
          entityId: req.params.id,
          after: { ...req.body, entry: r.entryId },
        });
        return { ok: true, entryId: r.entryId };
      }),
  );
};

/** R-FAC-05: alert the treasurer of invoices due within 3 days, once per invoice. */
export async function sendDueInvoiceAlerts(db: Db, now = new Date()): Promise<number> {
  const to = (await loadSettings(db))['pos.treasurerEmail'].email;
  if (!to) return 0;
  const limit = addDays(toParisDate(now), 3);
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: supplierInvoice.id,
        pieceRef: supplierInvoice.pieceRef,
        dueDate: supplierInvoice.dueDate,
        totalIncl: supplierInvoice.totalIncl,
        supplierName: supplier.name,
      })
      .from(supplierInvoice)
      .innerJoin(supplier, eq(supplier.id, supplierInvoice.supplierId))
      .where(
        and(
          eq(supplierInvoice.status, 'TO_PAY'),
          lte(supplierInvoice.dueDate, limit),
          isNull(supplierInvoice.dueReminderSentAt),
        ),
      )
      .orderBy(asc(supplierInvoice.dueDate))
      .for('update', { skipLocked: true });
    if (!due.length) return 0;
    const lines = due.map(
      (d) =>
        `${d.dueDate.split('-').reverse().join('/')} · ${d.supplierName} · pièce ${d.pieceRef} · ${eur(d.totalIncl)}`,
    );
    await queueEmail(tx, {
      to,
      subject: `Épicafé : ${due.length} facture(s) fournisseur à régler sous 3 jours`,
      text: lines.join('\n'),
      html: `<p>Factures à régler :</p><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    });
    await tx
      .update(supplierInvoice)
      .set({ dueReminderSentAt: now })
      .where(
        inArray(
          supplierInvoice.id,
          due.map((d) => d.id),
        ),
      );
    return due.length;
  });
}

export function startInvoiceAlertJob(db: Db, log: FastifyBaseLogger): () => void {
  const run = () =>
    sendDueInvoiceAlerts(db)
      .then((n) => n && log.info({ n }, 'alerte factures à échéance'))
      .catch((err) => log.error({ err }, 'alerte factures'));
  const timer = setInterval(run, 3600_000);
  void run();
  return () => clearInterval(timer);
}
