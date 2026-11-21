import ExcelJS from 'exceljs';
import { and, desc, eq, gte, lte, ne, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  supplier,
  supplierCreditAllocation,
  supplierCreditNote,
  supplierInvoice,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  buildCreditNoteEntry,
  centsToDecimal,
  creditNoteApplySchema,
  creditNoteSchema,
  creditNoteTooLargeProblem,
  decimalToCents,
  reasonSchema,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { allocatedCents } from '../accounting/credit-allocations';
import { supplierAccountNumber } from '../accounting/auto';
import { withdrawEntry } from '../accounting/invoice-corrections';
import { accountMap, createEntry, ensureAccount, plannedToLines } from '../accounting/service';

const idParams = { params: z.object({ id: z.string().uuid() }) };

/** Cents of a credit note already offset against invoices. */
async function creditNoteAllocated(db: Db | Tx, id: string): Promise<number> {
  const [r] = await db
    .select({ t: sql<string>`coalesce(sum(${supplierCreditAllocation.amount}), 0)::text` })
    .from(supplierCreditAllocation)
    .where(eq(supplierCreditAllocation.creditNoteId, id));
  return decimalToCents(r!.t);
}

/** Cents of active credit notes already linked to an invoice. */
async function creditedAgainst(db: Db | Tx, invoiceId: string, exceptId?: string) {
  const [r] = await db
    .select({ t: sql<string>`coalesce(sum(${supplierCreditNote.totalIncl}), 0)::text` })
    .from(supplierCreditNote)
    .where(
      and(
        eq(supplierCreditNote.invoiceId, invoiceId),
        eq(supplierCreditNote.status, 'ACTIVE'),
        exceptId ? ne(supplierCreditNote.id, exceptId) : undefined,
      ),
    );
  return decimalToCents(r!.t);
}

export const creditNoteRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const editors = { preHandler: app.requireRoles('APPROS', 'COMPTA') };

  const listQuery = z.object({
    supplierId: z.string().uuid().optional(),
    status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  });

  const list = async (q: z.infer<typeof listQuery>) => {
    const f: SQL[] = [];
    if (q.supplierId) f.push(eq(supplierCreditNote.supplierId, q.supplierId));
    if (q.status) f.push(eq(supplierCreditNote.status, q.status));
    if (q.from) f.push(gte(supplierCreditNote.date, q.from));
    if (q.to) f.push(lte(supplierCreditNote.date, q.to));
    return db
      .select({
        id: supplierCreditNote.id,
        supplierId: supplierCreditNote.supplierId,
        supplierName: supplier.name,
        invoiceId: supplierCreditNote.invoiceId,
        invoiceRef: supplierInvoice.pieceRef,
        pieceRef: supplierCreditNote.pieceRef,
        date: supplierCreditNote.date,
        totalExcl: supplierCreditNote.totalExcl,
        totalVat: supplierCreditNote.totalVat,
        totalIncl: supplierCreditNote.totalIncl,
        status: supplierCreditNote.status,
        allocated: sql<string>`coalesce((select sum(a.amount) from app.supplier_credit_allocation a where a.credit_note_id = ${supplierCreditNote.id}), 0)::numeric(12,2)::text`,
      })
      .from(supplierCreditNote)
      .innerJoin(supplier, eq(supplier.id, supplierCreditNote.supplierId))
      .leftJoin(supplierInvoice, eq(supplierInvoice.id, supplierCreditNote.invoiceId))
      .where(and(...f))
      .orderBy(desc(supplierCreditNote.date))
      .limit(1000);
  };

  app.get('/supplier-credit-notes', { ...editors, schema: { querystring: listQuery } }, (req) =>
    list(req.query),
  );

  app.get(
    '/supplier-credit-notes.xlsx',
    { ...editors, schema: { querystring: listQuery } },
    async (req, reply) => {
      const rows = await list(req.query);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Avoirs');
      const money = { numFmt: '#,##0.00 €' };
      ws.columns = [
        { header: 'Fournisseur', key: 'supplierName', width: 30 },
        { header: 'Pièce', key: 'pieceRef', width: 18 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Facture liée', key: 'invoiceRef', width: 18 },
        { header: 'HT', key: 'totalExcl', width: 12, style: money },
        { header: 'TVA', key: 'totalVat', width: 12, style: money },
        { header: 'TTC', key: 'totalIncl', width: 12, style: money },
        { header: 'Imputé', key: 'allocated', width: 12, style: money },
        { header: 'Reste', key: 'remaining', width: 12, style: money },
        { header: 'État', key: 'status', width: 12 },
      ];
      ws.getRow(1).font = { bold: true };
      for (const r of rows)
        ws.addRow({
          ...r,
          invoiceRef: r.invoiceRef ?? '',
          totalExcl: Number(r.totalExcl),
          totalVat: Number(r.totalVat),
          totalIncl: Number(r.totalIncl),
          allocated: Number(r.allocated),
          remaining: (decimalToCents(r.totalIncl) - decimalToCents(r.allocated)) / 100,
          status: r.status === 'CANCELLED' ? 'Annulé' : 'Valide',
        });
      const buf = await wb.xlsx.writeBuffer();
      return reply
        .header('content-disposition', 'attachment; filename="avoirs-fournisseurs.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(Buffer.from(buf));
    },
  );

  app.get('/supplier-credit-notes/:id', { ...editors, schema: idParams }, async (req) => {
    const note = await db.query.supplierCreditNote.findFirst({
      where: eq(supplierCreditNote.id, req.params.id),
    });
    if (!note) throw notFound('Avoir introuvable.');
    const allocations = await db
      .select({
        id: supplierCreditAllocation.id,
        invoiceId: supplierCreditAllocation.invoiceId,
        invoiceRef: supplierInvoice.pieceRef,
        amount: supplierCreditAllocation.amount,
        date: supplierCreditAllocation.date,
      })
      .from(supplierCreditAllocation)
      .innerJoin(supplierInvoice, eq(supplierInvoice.id, supplierCreditAllocation.invoiceId))
      .where(eq(supplierCreditAllocation.creditNoteId, note.id));
    const allocated = allocations.reduce((s, a) => s + decimalToCents(a.amount), 0);
    return {
      ...note,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
      cancelledAt: note.cancelledAt?.toISOString() ?? null,
      allocations,
      allocated: centsToDecimal(allocated),
      remaining: centsToDecimal(decimalToCents(note.totalIncl) - allocated),
    };
  });

  app.post('/supplier-credit-notes', { ...editors, schema: { body: creditNoteSchema } }, (req) =>
    db.transaction(async (tx) => {
      const b = req.body;
      const [s] = await tx.select().from(supplier).where(eq(supplier.id, b.supplierId));
      if (!s) throw badRequest('Fournisseur inconnu.');
      const cents = decimalToCents(b.totalIncl);
      let expenseAccount: string | null = null;
      if (b.invoiceId) {
        const [inv] = await tx
          .select()
          .from(supplierInvoice)
          .where(eq(supplierInvoice.id, b.invoiceId))
          .for('update');
        if (!inv) throw badRequest('Facture inconnue.');
        if (inv.supplierId !== s.id)
          throw badRequest('Cette facture est celle d’un autre fournisseur.');
        if (inv.status === 'CANCELLED')
          throw conflict('Cette facture est annulée : un avoir ne s’y rapporte plus.');
        const problem = creditNoteTooLargeProblem({
          creditCents: cents,
          invoiceCents: decimalToCents(inv.totalIncl),
          alreadyCreditedCents: await creditedAgainst(tx, inv.id),
        });
        if (problem) throw conflict(problem);
        expenseAccount = inv.expenseAccountNumber;
        if (b.date < inv.date)
          throw badRequest('La date de l’avoir ne peut pas précéder celle de la facture.');
      }
      const [dup] = await tx
        .select({ id: supplierCreditNote.id })
        .from(supplierCreditNote)
        .where(
          and(
            eq(supplierCreditNote.supplierId, s.id),
            eq(supplierCreditNote.pieceRef, b.pieceRef),
            eq(supplierCreditNote.status, 'ACTIVE'),
          ),
        );
      if (dup) throw conflict(`L’avoir ${b.pieceRef} de ce fournisseur est déjà enregistré.`);
      const [note] = await tx
        .insert(supplierCreditNote)
        .values({
          supplierId: s.id,
          invoiceId: b.invoiceId,
          pieceRef: b.pieceRef,
          date: b.date,
          totalExcl: b.totalExcl,
          totalVat: b.totalVat,
          totalIncl: b.totalIncl,
          expenseAccountNumber: expenseAccount,
          comment: b.comment,
          createdBy: req.user!.id,
        })
        .returning();
      // The entry of the credit note: the opposite of an invoice (401 debited, expense credited).
      const a = await accountMap(tx);
      const sup = await supplierAccountNumber(tx, s.id);
      const expense = expenseAccount ?? a.purchases;
      await ensureAccount(tx, expense, 'Achats');
      const entryId = await createEntry(tx, {
        journalCode: 'ACH',
        date: b.date,
        pieceRef: b.pieceRef,
        label: `Avoir ${sup.name}`,
        mode: null,
        lines: plannedToLines(
          buildCreditNoteEntry({
            supplierAccount: sup.number,
            expenseAccount: expense,
            cents,
            label: `Avoir ${sup.name}`,
          }),
        ),
        source: { type: 'credit_note', id: note!.id },
        userId: req.user!.id,
        autoFiscalYear: true,
      });
      await tx
        .update(supplierCreditNote)
        .set({ entryId })
        .where(eq(supplierCreditNote.id, note!.id));
      await audit(tx, req, {
        action: 'credit_note.create',
        entity: 'supplier_credit_note',
        entityId: note!.id,
        after: { ...note, entryId },
      });
      return { id: note!.id, entryId };
    }),
  );

  /** Offsets (part of) a credit note against an invoice to pay of the same supplier. */
  app.post(
    '/supplier-credit-notes/:id/apply',
    { ...editors, schema: { ...idParams, body: creditNoteApplySchema } },
    (req) =>
      db.transaction(async (tx) => {
        const [note] = await tx
          .select()
          .from(supplierCreditNote)
          .where(eq(supplierCreditNote.id, req.params.id))
          .for('update');
        if (!note) throw notFound('Avoir introuvable.');
        if (note.status !== 'ACTIVE') throw conflict('Cet avoir est annulé.');
        const [inv] = await tx
          .select()
          .from(supplierInvoice)
          .where(eq(supplierInvoice.id, req.body.invoiceId))
          .for('update');
        if (!inv) throw badRequest('Facture inconnue.');
        if (inv.supplierId !== note.supplierId)
          throw conflict('L’avoir et la facture sont de deux fournisseurs différents.');
        if (inv.status !== 'TO_PAY')
          throw conflict(
            inv.status === 'PAID'
              ? 'Cette facture est déjà réglée : on n’y impute plus d’avoir.'
              : 'Cette facture est annulée.',
          );
        const cents = decimalToCents(req.body.amount);
        const left = decimalToCents(note.totalIncl) - (await creditNoteAllocated(tx, note.id));
        if (cents > left)
          throw conflict(`Il ne reste que ${centsToDecimal(left)} € à imputer sur cet avoir.`);
        const due = decimalToCents(inv.totalIncl) - (await allocatedCents(tx, inv.id));
        if (cents > due)
          throw conflict(`La facture n’a plus que ${centsToDecimal(due)} € à régler.`);
        const [al] = await tx
          .insert(supplierCreditAllocation)
          .values({
            creditNoteId: note.id,
            invoiceId: inv.id,
            amount: req.body.amount,
            date: req.body.date,
            createdBy: req.user!.id,
          })
          .returning();
        await audit(tx, req, {
          action: 'credit_note.apply',
          entity: 'supplier_credit_note',
          entityId: note.id,
          after: { invoice: inv.pieceRef, amount: req.body.amount },
        });
        return { id: al!.id, netToPay: centsToDecimal(due - cents) };
      }),
  );

  /** Removes an imputation as long as the invoice is not paid. */
  app.delete('/supplier-credit-allocations/:id', { ...editors, schema: idParams }, (req) =>
    db.transaction(async (tx) => {
      const [al] = await tx
        .select()
        .from(supplierCreditAllocation)
        .where(eq(supplierCreditAllocation.id, req.params.id));
      if (!al) throw notFound('Imputation introuvable.');
      const [inv] = await tx
        .select()
        .from(supplierInvoice)
        .where(eq(supplierInvoice.id, al.invoiceId))
        .for('update');
      if (inv!.status === 'PAID')
        throw conflict(
          'La facture est réglée : annulez d’abord son règlement pour retirer cette imputation.',
        );
      await tx.delete(supplierCreditAllocation).where(eq(supplierCreditAllocation.id, al.id));
      await audit(tx, req, {
        action: 'credit_note.unapply',
        entity: 'supplier_credit_note',
        entityId: al.creditNoteId,
        before: al,
      });
      return { ok: true };
    }),
  );

  /** Cancels a credit note entered by mistake: counter entry, motif required, never deleted. */
  app.post(
    '/supplier-credit-notes/:id/cancel',
    { ...editors, schema: { ...idParams, body: reasonSchema } },
    (req) =>
      db.transaction(async (tx) => {
        const [note] = await tx
          .select()
          .from(supplierCreditNote)
          .where(eq(supplierCreditNote.id, req.params.id))
          .for('update');
        if (!note) throw notFound('Avoir introuvable.');
        if (note.status === 'CANCELLED') throw conflict('Cet avoir est déjà annulé.');
        if ((await creditNoteAllocated(tx, note.id)) > 0)
          throw conflict('Cet avoir est imputé sur une facture : retirez d’abord l’imputation.');
        let cancelEntryId: string | null = null;
        if (note.entryId)
          cancelEntryId = await withdrawEntry(tx, note.entryId, {
            label: `Annulation de l’avoir ${note.pieceRef} (${req.body.reason})`,
            userId: req.user!.id,
            source: { type: 'credit_note_cancel', id: note.id },
          });
        await tx
          .update(supplierCreditNote)
          .set({
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: req.body.reason,
            cancelEntryId,
          })
          .where(eq(supplierCreditNote.id, note.id));
        await audit(tx, req, {
          action: 'credit_note.cancel',
          entity: 'supplier_credit_note',
          entityId: note.id,
          before: note,
          after: { reason: req.body.reason, cancelEntryId },
        });
        return { ok: true, cancelEntryId };
      }),
  );
};
