import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { memberPayment, walletEntry, type Db } from '@episoft/db';
import {
  formatEuro,
  PAYMENT_METHOD_LABELS,
  WALLET_ENTRY_KIND_LABELS,
  type PaymentMethod,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { formatParis, toParisDate } from '../../lib/dates';
import { escapeHtml, queueEmail } from '../../lib/mail';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { householdDetail } from './routes';

const idParams = { params: z.object({ id: z.string().uuid() }) };

/** R-CAG-07 (export, e-mail) and R-CAG-08 (same-day cancellation of a top-up). */
export const walletRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const adherents = { preHandler: app.requireRoles('ADHERENTS') };

  app.get('/households/:id/wallet.xlsx', { ...adherents, schema: idParams }, async (req, reply) => {
    const h = await householdDetail(db, req.params.id);
    if (!h) throw notFound('Foyer introuvable.');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cagnotte');
    ws.columns = [
      { header: 'Date', key: 'at', width: 18 },
      { header: 'Opération', key: 'kind', width: 16 },
      { header: 'Mode', key: 'method', width: 12 },
      { header: 'Ticket', key: 'sale', width: 16 },
      { header: 'Commentaire', key: 'comment', width: 40 },
      { header: 'Montant', key: 'amount', width: 12, style: { numFmt: '#,##0.00 €' } },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const w of [...h.wallet].reverse()) {
      ws.addRow({
        at: formatParis(new Date(w.at)),
        kind: WALLET_ENTRY_KIND_LABELS[w.kind],
        method: w.paymentMethod ? PAYMENT_METHOD_LABELS[w.paymentMethod as PaymentMethod] : '',
        sale: w.saleNumber ?? '',
        comment: w.comment ?? '',
        amount: Number(w.amount),
      });
    }
    ws.addRow({ comment: 'Solde', amount: Number(h.balance) }).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    return reply
      .header('content-disposition', `attachment; filename="cagnotte-foyer-${h.number}.xlsx"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(Buffer.from(buf));
  });

  app.post(
    '/households/:id/wallet/email',
    { ...adherents, schema: idParams },
    async (req, reply) => {
      await db.transaction(async (tx) => {
        const h = await householdDetail(tx, req.params.id);
        if (!h) throw notFound('Foyer introuvable.');
        const to =
          h.members.find((m) => m.id === h.referentMemberId && m.email) ??
          h.members.find((m) => m.email && m.status !== 'ARCHIVED');
        if (!to?.email) throw badRequest('Aucun membre du foyer n’a de courriel.');
        const rows = h.wallet
          .map(
            (w) =>
              `<tr><td style="padding:2px 8px 2px 0">${formatParis(new Date(w.at))}</td><td style="padding:2px 8px">${escapeHtml(WALLET_ENTRY_KIND_LABELS[w.kind])}${w.saleNumber ? ` (${escapeHtml(w.saleNumber)})` : ''}</td><td style="padding:2px 0;text-align:right">${formatEuro(w.amount)}</td></tr>`,
          )
          .join('');
        await queueEmail(tx, {
          to: to.email,
          subject: `Épicafé : historique de votre cagnotte (solde ${formatEuro(h.balance)})`,
          html: `<p>Bonjour ${escapeHtml(to.firstName)},</p><p>Solde actuel de la cagnotte de votre foyer : <strong>${formatEuro(h.balance)}</strong>.</p><table style="border-collapse:collapse;font-size:14px">${rows}</table>`,
          text:
            `Bonjour ${to.firstName},\n\nSolde actuel : ${formatEuro(h.balance)}\n\n` +
            h.wallet
              .map(
                (w) =>
                  `${formatParis(new Date(w.at))}  ${WALLET_ENTRY_KIND_LABELS[w.kind]}  ${formatEuro(w.amount)}`,
              )
              .join('\n'),
        });
        await audit(tx, req, {
          action: 'wallet.history_sent',
          entity: 'household',
          entityId: h.id,
          after: { to: to.email },
        });
      });
      return reply.status(204).send();
    },
  );

  /**
   * R-CAG-08: a top-up entered at the back office can be cancelled on the same day only
   * (an input error). Afterwards, a CORRECTION entry is required. Till top-ups belong to a
   * cash session and are never deleted here.
   */
  app.post('/wallet-entries/:id/cancel', { ...adherents, schema: idParams }, async (req) => {
    await db.transaction(async (tx) => {
      const [e] = await tx
        .select()
        .from(walletEntry)
        .where(eq(walletEntry.id, req.params.id))
        .for('update');
      if (!e) throw notFound('Opération introuvable.');
      if (e.kind !== 'TOPUP' || !e.paymentId || e.saleId)
        throw conflict('Seul un versement saisi au back-office peut être annulé.');
      const pay = await tx.query.memberPayment.findFirst({
        where: eq(memberPayment.id, e.paymentId),
      });
      if (pay?.cashSessionId)
        throw conflict('Un versement fait en caisse ne peut pas être annulé ici.');
      if (toParisDate(e.createdAt) !== toParisDate(new Date())) {
        throw conflict(
          'Un versement ne peut être annulé que le jour même. Utilisez une correction.',
        );
      }
      await tx.delete(walletEntry).where(eq(walletEntry.id, e.id));
      await tx.delete(memberPayment).where(eq(memberPayment.id, e.paymentId));
      await audit(tx, req, {
        action: 'wallet.topup_cancel',
        entity: 'household',
        entityId: e.householdId,
        before: { entry: e, payment: pay },
      });
    });
    return { ok: true };
  });
};
