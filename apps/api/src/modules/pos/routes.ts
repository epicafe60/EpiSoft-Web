import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  cashCount,
  cashSession,
  entry,
  member,
  posDevice,
  sale,
  saleLine,
  salePayment,
  type Db,
} from '@episoft/db';
import {
  centsToDecimal,
  closing,
  cashGapNeedsComment,
  countedCashCents,
  decimalToCents,
  DENOMINATIONS,
  syncPushSchema,
  type PaymentMethod,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { formatParis } from '../../lib/dates';
import { escapeHtml, queueEmail } from '../../lib/mail';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { euros, saleReceiptEmail } from '../../lib/receipts';
import { loadSettings } from '../admin/settings-store';
import { sessionSummary, type SessionSummary } from './closing';
import { closingPdf } from './closing-pdf';
import { generateSessionEntry } from '../accounting/auto';
import { pdfAttachment } from '../../lib/mail';
import { buildSnapshot } from './snapshot';
import { NotYet, processOps, Rejected } from './sync-service';

const amount = z
  .string()
  .regex(/^\d+([.,]\d{1,2})?$/, 'Montant invalide.')
  .transform((s) => s.replace(',', '.'));

export const posRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const cashier = { preHandler: app.requireRoles('CAISSE') };
  const cashierOrAdmin = { preHandler: app.requireRoles('CAISSE', 'ADMIN', 'COMPTA') };

  // --- Devices (R-ADM-03) ------------------------------------------------------

  app.post(
    '/pos/devices',
    { ...cashier, schema: { body: z.object({ name: z.string().trim().min(1).max(40) }) } },
    async (req) => {
      return db.transaction(async (tx) => {
        const existing = await tx.query.posDevice.findFirst({
          where: eq(posDevice.name, req.body.name),
        });
        if (existing) throw conflict('Un poste porte déjà ce nom.');
        const [d] = await tx
          .insert(posDevice)
          .values({ name: req.body.name, createdBy: req.user!.id })
          .returning();
        await audit(tx, req, {
          action: 'device.create',
          entity: 'pos_device',
          entityId: d!.id,
          after: { name: d!.name },
        });
        return { id: d!.id, name: d!.name };
      });
    },
  );

  app.get('/pos/devices', cashierOrAdmin, async () => {
    const rows = await db
      .select({
        id: posDevice.id,
        name: posDevice.name,
        active: posDevice.active,
        lastSyncAt: posDevice.lastSyncAt,
        openSessionId: sql<
          string | null
        >`(select id from app.cash_session s where s.device_id = ${posDevice.id} and s.status = 'OPEN')`,
      })
      .from(posDevice)
      .orderBy(posDevice.name);
    return rows.map((r) => ({ ...r, lastSyncAt: r.lastSyncAt?.toISOString() ?? null }));
  });

  /** What the till needs at start-up: the device, its open session and the float to propose. */
  app.get(
    '/pos/devices/:id/state',
    { ...cashier, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const device = await db.query.posDevice.findFirst({ where: eq(posDevice.id, req.params.id) });
      if (!device) throw notFound('Poste inconnu.');
      const open = await db.query.cashSession.findFirst({
        where: and(eq(cashSession.deviceId, device.id), eq(cashSession.status, 'OPEN')),
      });
      const [last] = await db
        .select({ nextFloat: cashCount.nextFloat })
        .from(cashCount)
        .innerJoin(cashSession, eq(cashSession.id, cashCount.sessionId))
        .where(eq(cashSession.deviceId, device.id))
        .orderBy(desc(cashSession.closedAt))
        .limit(1);
      const settings = await loadSettings(db);
      return {
        device: { id: device.id, name: device.name, active: device.active },
        openSession: open
          ? { id: open.id, openedAt: open.openedAt.toISOString(), openingFloat: open.openingFloat }
          : null,
        // R-SES-01: the float is carried over from the previous closing.
        proposedFloat: last?.nextFloat ?? settings['pos.defaultFloat'].amount,
      };
    },
  );

  // --- Synchronisation (§8.3) ----------------------------------------------------

  app.get(
    '/sync/snapshot',
    {
      ...cashier,
      schema: {
        querystring: z.object({ since: z.string().datetime({ offset: true }).optional() }),
      },
    },
    async (req) => buildSnapshot(db, req.query.since ? new Date(req.query.since) : null),
  );

  // Tills share one address: generous, but a stuck loop is stopped.
  app.post(
    '/sync/push',
    {
      ...cashier,
      schema: { body: syncPushSchema },
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    },
    async (req) => {
      try {
        return { results: await processOps(db, req, config, req.body.deviceId, req.body.ops) };
      } catch (e) {
        if (e instanceof Rejected) throw badRequest(e.message);
        // A cancellation ahead of its ticket: the till sends it again.
        if (e instanceof NotYet) throw conflict(e.message);
        throw e;
      }
    },
  );

  // --- Sessions (§4.5) --------------------------------------------------------------

  const sessionParams = { params: z.object({ id: z.string().uuid() }) };

  app.get(
    '/pos/sessions',
    {
      ...cashierOrAdmin,
      schema: {
        querystring: z.object({
          deviceId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(30),
        }),
      },
    },
    async (req) => {
      const rows = await db
        .select({
          id: cashSession.id,
          deviceName: posDevice.name,
          status: cashSession.status,
          openedAt: cashSession.openedAt,
          closedAt: cashSession.closedAt,
          openingFloat: cashSession.openingFloat,
          difference: cashCount.difference,
          salesCount: sql<number>`(select count(*)::int from app.sale x where x.session_id = ${cashSession.id} and x.cancels_sale_id is null)`,
          salesTotal: sql<string>`(select coalesce(sum(total), 0)::numeric(12,2)::text from app.sale x where x.session_id = ${cashSession.id})`,
        })
        .from(cashSession)
        .innerJoin(posDevice, eq(posDevice.id, cashSession.deviceId))
        .leftJoin(cashCount, eq(cashCount.sessionId, cashSession.id))
        .where(req.query.deviceId ? eq(cashSession.deviceId, req.query.deviceId) : undefined)
        .orderBy(desc(cashSession.openedAt))
        .limit(req.query.limit);
      return rows.map((r) => ({
        ...r,
        openedAt: r.openedAt.toISOString(),
        closedAt: r.closedAt?.toISOString() ?? null,
      }));
    },
  );

  app.get(
    '/pos/sessions/:id/summary',
    { ...cashierOrAdmin, schema: sessionParams },
    async (req) => {
      const s = await db.query.cashSession.findFirst({ where: eq(cashSession.id, req.params.id) });
      if (!s) throw notFound('Session inconnue.');
      return sessionSummary(db, s.id);
    },
  );

  const closeSchema = z.object({
    denominations: z.record(
      z.enum(DENOMINATIONS.map(String) as [string, ...string[]]),
      z.number().int().min(0).max(100_000),
    ),
    bankDeposit: amount,
    chequesCount: z.number().int().min(0).max(1000),
    chequesTotal: amount,
    cardTotalDeclared: amount,
    comment: z.string().max(1000).optional(),
    /** R-OFF-07: the device still had operations waiting to be sent. */
    forced: z.boolean().default(false),
  });

  type CloseBody = z.infer<typeof closeSchema>;

  /**
   * Closes a session once: records the count, the accounting draft and sends the report.
   * `administrative` (ADMIN) closes without a count: the cash is taken as the expected amount.
   */
  const closeSession = async (
    req: FastifyRequest,
    id: string,
    b: CloseBody,
    administrative = false,
  ) => {
    const report = await db.transaction(async (tx) => {
      const [s] = await tx.select().from(cashSession).where(eq(cashSession.id, id)).for('update');
      if (!s) throw notFound('Session inconnue.');
      if (s.status === 'CLOSED') throw conflict('Cette session est déjà clôturée.');
      const summary = await sessionSummary(tx, s.id);
      const expected =
        decimalToCents(s.openingFloat) +
        decimalToCents(summary.cashSales) +
        decimalToCents(summary.cashOther);
      const counted = administrative ? expected : countedCashCents(b.denominations);
      const result = closing({
        openingFloatCents: decimalToCents(s.openingFloat),
        cashSalesCents: decimalToCents(summary.cashSales),
        cashOtherCents: decimalToCents(summary.cashOther),
        countedCashCents: counted,
        bankDepositCents: decimalToCents(b.bankDeposit),
      });
      if (result.nextFloatCents < 0)
        throw badRequest('Le dépôt en banque dépasse les espèces comptées.');
      // An unexplained gap, or a closing that goes ahead with tickets not yet sent, needs a reason
      // written down: the treasurer reads it in the closing report.
      const reason = (b.comment ?? '').trim();
      if (!administrative) {
        const thresholds = (await loadSettings(tx))['controls.thresholds'];
        if (cashGapNeedsComment(result.differenceCents, thresholds) && reason.length < 3)
          throw badRequest(
            `Écart de caisse de ${centsToDecimal(result.differenceCents)} € : expliquez-le dans le commentaire avant de clôturer.`,
          );
        if (b.forced && reason.length < 3)
          throw badRequest(
            'Des tickets de ce poste n’ont pas été envoyés : indiquez dans le commentaire pourquoi vous clôturez quand même.',
          );
      }
      const values = {
        sessionId: s.id,
        denominations: b.denominations,
        countedCash: centsToDecimal(counted),
        expectedCash: centsToDecimal(result.expectedCashCents),
        difference: centsToDecimal(result.differenceCents),
        bankDeposit: b.bankDeposit,
        nextFloat: centsToDecimal(result.nextFloatCents),
        chequesCount: b.chequesCount,
        chequesTotal: b.chequesTotal,
        cardTotalDeclared: b.cardTotalDeclared,
        summary,
        comment: b.comment ?? null,
      };
      await tx.insert(cashCount).values(values);
      const closedAt = new Date();
      await tx
        .update(cashSession)
        .set({ status: 'CLOSED', closedAt, closedBy: req.user!.id })
        .where(eq(cashSession.id, s.id));
      await audit(tx, req, {
        action: 'session.close',
        entity: 'cash_session',
        entityId: s.id,
        after: { ...values, summary: undefined, forced: b.forced },
      });

      // R-CPT-08: the VTE draft. In a savepoint: an accounting problem never blocks the cash closing.
      try {
        await tx.transaction((sp) => generateSessionEntry(sp, s.id, req.user!.id));
      } catch (e) {
        req.log.error({ err: e, session: s.id }, 'écriture de caisse non générée');
        await audit(tx, req, {
          action: 'session.entry_failed',
          entity: 'cash_session',
          entityId: s.id,
          after: { error: String(e) },
        });
      }

      const treasurer = (await loadSettings(tx))['pos.treasurerEmail'].email;
      const device = await tx.query.posDevice.findFirst({ where: eq(posDevice.id, s.deviceId) });
      if (treasurer) {
        await queueEmail(tx, {
          ...closingReportEmail(
            treasurer,
            device?.name ?? '',
            s.openedAt,
            closedAt,
            summary,
            values,
            b.forced,
          ),
          attachments: [pdfAttachment('cloture.pdf', await closingPdf(tx, s.id))],
        });
      }
      return { ...values, closedAt: closedAt.toISOString() };
    });
    return report;
  };

  /** R-SES-02 / R-SES-03: the till closes its own session. */
  app.post(
    '/pos/sessions/:id/close',
    { ...cashier, schema: { ...sessionParams, body: closeSchema } },
    async (req) => closeSession(req, req.params.id, req.body),
  );

  /**
   * An ADMIN closes any session left open (forgotten, device lost), with no count: the cash is
   * taken as the expected amount, nothing is deposited, and the comment says why. Audited.
   */
  app.post(
    '/pos/sessions/:id/force-close',
    {
      preHandler: app.requireRoles('ADMIN'),
      schema: { ...sessionParams, body: z.object({ comment: z.string().trim().min(3).max(500) }) },
    },
    async (req) =>
      closeSession(
        req,
        req.params.id,
        {
          denominations: {},
          bankDeposit: '0.00',
          chequesCount: 0,
          chequesTotal: '0.00',
          cardTotalDeclared: '0.00',
          comment: `Clôture administrative : ${req.body.comment}`,
          forced: true,
        },
        true,
      ),
  );

  app.post(
    '/pos/sessions/:id/reopen',
    // R-EVO-05: the treasury team can undo a closing too, until its entry is validated.
    { preHandler: app.requireRoles('ADMIN', 'COMPTA'), schema: sessionParams },
    async (req) => {
      await db.transaction(async (tx) => {
        const [s] = await tx
          .select()
          .from(cashSession)
          .where(eq(cashSession.id, req.params.id))
          .for('update');
        if (!s) throw notFound('Session inconnue.');
        if (s.status !== 'CLOSED') throw conflict('Cette session n’est pas clôturée.');
        const other = await tx.query.cashSession.findFirst({
          where: and(eq(cashSession.deviceId, s.deviceId), eq(cashSession.status, 'OPEN')),
        });
        if (other) throw conflict('Une autre session est ouverte sur ce poste.');
        // A validated accounting entry has to be reversed first; a draft is dropped and regenerated at the next closing.
        if (s.entryId) {
          const [e] = await tx.select().from(entry).where(eq(entry.id, s.entryId));
          if (e?.status === 'VALIDATED')
            throw conflict(
              'L’écriture comptable de cette session est validée : contre-passez-la d’abord.',
            );
          await tx.update(cashSession).set({ entryId: null }).where(eq(cashSession.id, s.id));
          if (e) await tx.delete(entry).where(eq(entry.id, e.id));
        }
        const [count] = await tx.delete(cashCount).where(eq(cashCount.sessionId, s.id)).returning();
        await tx
          .update(cashSession)
          .set({ status: 'OPEN', closedAt: null, closedBy: null })
          .where(eq(cashSession.id, s.id));
        await audit(tx, req, {
          action: 'session.reopen',
          entity: 'cash_session',
          entityId: s.id,
          before: count ?? null,
        });
      });
      return { ok: true };
    },
  );

  app.get(
    '/pos/sessions/:id/report.pdf',
    { ...cashierOrAdmin, schema: sessionParams },
    async (req, reply) => {
      const s = await db.query.cashSession.findFirst({ where: eq(cashSession.id, req.params.id) });
      if (!s) throw notFound('Session inconnue.');
      return reply
        .header('content-disposition', 'inline; filename="cloture.pdf"')
        .type('application/pdf')
        .send(await closingPdf(db, s.id));
    },
  );

  app.get('/pos/sessions/:id/report', { ...cashierOrAdmin, schema: sessionParams }, async (req) => {
    const s = await db.query.cashSession.findFirst({ where: eq(cashSession.id, req.params.id) });
    if (!s) throw notFound('Session inconnue.');
    const device = await db.query.posDevice.findFirst({ where: eq(posDevice.id, s.deviceId) });
    const count = await db.query.cashCount.findFirst({ where: eq(cashCount.sessionId, s.id) });
    return {
      session: {
        id: s.id,
        deviceName: device?.name ?? '',
        status: s.status,
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt?.toISOString() ?? null,
        openingFloat: s.openingFloat,
      },
      summary: count ? (count.summary as SessionSummary) : await sessionSummary(db, s.id),
      count: count ?? null,
    };
  });

  // --- Sales (R-VTE-12, R-VTE-16) -------------------------------------------------

  app.get(
    '/pos/sales',
    {
      preHandler: app.requireRoles('CAISSE', 'ADHERENTS', 'ADMIN'),
      schema: {
        querystring: z.object({
          sessionId: z.string().uuid().optional(),
          memberId: z.string().uuid().optional(),
          householdId: z.string().uuid().optional(),
          before: z.string().datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      if (!q.sessionId && !q.memberId && !q.householdId)
        throw badRequest('Précisez une session, un membre ou un foyer.');
      const f: SQL[] = [];
      if (q.sessionId) f.push(eq(sale.sessionId, q.sessionId));
      if (q.memberId) f.push(eq(sale.memberId, q.memberId));
      if (q.householdId) f.push(eq(sale.householdId, q.householdId));
      if (q.before) f.push(lt(sale.soldAt, new Date(q.before)));
      const rows = await db
        .select({
          id: sale.id,
          number: sale.number,
          provisionalNumber: sale.provisionalNumber,
          soldAt: sale.soldAt,
          total: sale.total,
          status: sale.status,
          cancelsSaleId: sale.cancelsSaleId,
          memberName: sql<string | null>`${member.firstName} || ' ' || ${member.lastName}`,
          memberId: sale.memberId,
          sessionId: sale.sessionId,
          warnings: sale.warnings,
        })
        .from(sale)
        .leftJoin(member, eq(member.id, sale.memberId))
        .where(and(...f))
        .orderBy(desc(sale.soldAt))
        .limit(q.limit);
      const pays = rows.length
        ? await db
            .select()
            .from(salePayment)
            .where(
              inArray(
                salePayment.saleId,
                rows.map((r) => r.id),
              ),
            )
        : [];
      return rows.map((r) => ({
        ...r,
        soldAt: r.soldAt.toISOString(),
        payments: pays
          .filter((p) => p.saleId === r.id)
          .map((p) => ({ method: p.method as PaymentMethod, amount: p.amount })),
      }));
    },
  );

  app.get(
    '/pos/sales/:id',
    { preHandler: app.requireRoles('CAISSE', 'ADHERENTS', 'ADMIN'), schema: sessionParams },
    async (req) => {
      const s = await db.query.sale.findFirst({ where: eq(sale.id, req.params.id) });
      if (!s) throw notFound('Ticket introuvable.');
      const lines = await db
        .select()
        .from(saleLine)
        .where(eq(saleLine.saleId, s.id))
        .orderBy(saleLine.lineNo);
      const payments = await db.select().from(salePayment).where(eq(salePayment.saleId, s.id));
      const people = await db
        .select({
          id: member.id,
          name: sql<string>`${member.firstName} || ' ' || ${member.lastName}`,
        })
        .from(member)
        .where(
          inArray(
            member.id,
            [s.memberId, s.cashierId].filter((x): x is string => !!x),
          ),
        );
      const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
      const cancelledBy = await db.query.sale.findFirst({
        where: eq(sale.cancelsSaleId, s.id),
        columns: { id: true, number: true },
      });
      return {
        ...s,
        soldAt: s.soldAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
        emailSentAt: s.emailSentAt?.toISOString() ?? null,
        memberName: nameOf(s.memberId),
        cashierName: nameOf(s.cashierId),
        cancelledBy: cancelledBy ?? null,
        lines,
        payments,
      };
    },
  );

  app.post(
    '/pos/sales/:id/email',
    { preHandler: app.requireRoles('CAISSE', 'ADHERENTS'), schema: sessionParams },
    async (req, reply) => {
      await db.transaction(async (tx) => {
        const s = await tx.query.sale.findFirst({ where: eq(sale.id, req.params.id) });
        if (!s) throw notFound('Ticket introuvable.');
        const m = s.memberId
          ? await tx.query.member.findFirst({ where: eq(member.id, s.memberId) })
          : null;
        if (!m?.email)
          throw badRequest('Ce ticket n’est rattaché à aucun adhérent ayant un courriel.');
        const lines = await tx
          .select()
          .from(saleLine)
          .where(eq(saleLine.saleId, s.id))
          .orderBy(saleLine.lineNo);
        const pays = await tx.select().from(salePayment).where(eq(salePayment.saleId, s.id));
        await queueEmail(
          tx,
          saleReceiptEmail(m.email, m.firstName, {
            number: s.number,
            soldAt: s.soldAt,
            total: s.total,
            lines,
            payments: pays.map((p) => ({ method: p.method as PaymentMethod, amount: p.amount })),
            cashierName: null,
          }),
        );
        await tx.update(sale).set({ emailSentAt: new Date() }).where(eq(sale.id, s.id));
      });
      return reply.status(204).send();
    },
  );
};

function closingReportEmail(
  to: string,
  deviceName: string,
  openedAt: Date,
  closedAt: Date,
  summary: SessionSummary,
  count: {
    countedCash: string;
    expectedCash: string;
    difference: string;
    bankDeposit: string;
    nextFloat: string;
    chequesCount: number;
    chequesTotal: string;
    cardTotalDeclared: string;
    comment: string | null;
  },
  forced: boolean,
) {
  const rows: [string, string][] = [
    ['Poste', deviceName],
    ['Ouverture', formatParis(openedAt)],
    ['Clôture', formatParis(closedAt)],
    ['Tickets', `${summary.salesCount} (annulations : ${summary.cancellationsCount})`],
    ['Total des ventes', euros(decimalToCents(summary.salesTotal))],
    ['Espèces', euros(decimalToCents(summary.byMethod.CASH))],
    ['Chèques', euros(decimalToCents(summary.byMethod.CHEQUE))],
    ['Cartes', euros(decimalToCents(summary.byMethod.CARD))],
    ['Cagnotte', euros(decimalToCents(summary.byMethod.WALLET))],
    ['Virements', euros(decimalToCents(summary.byMethod.TRANSFER))],
    ['Encaissements hors ventes en espèces', euros(decimalToCents(summary.cashOther))],
    ['Fond initial', euros(decimalToCents(summary.openingFloat))],
    ['Espèces théoriques', euros(decimalToCents(count.expectedCash))],
    ['Espèces comptées', euros(decimalToCents(count.countedCash))],
    ['Écart', euros(decimalToCents(count.difference))],
    ['Dépôt en banque', euros(decimalToCents(count.bankDeposit))],
    ['Nouveau fond', euros(decimalToCents(count.nextFloat))],
    [
      'Chèques remis',
      `${count.chequesCount} pour ${euros(decimalToCents(count.chequesTotal))} (calculé ${euros(decimalToCents(summary.chequesComputed))})`,
    ],
    [
      'Cartes déclarées',
      `${euros(decimalToCents(count.cardTotalDeclared))} (calculé ${euros(decimalToCents(summary.cardComputed))})`,
    ],
  ];
  if (count.comment) rows.push(['Commentaire', count.comment]);
  if (forced)
    rows.push([
      'Attention',
      'Clôture forcée : des opérations du poste n’étaient pas encore envoyées.',
    ]);
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2>Clôture de caisse</h2><table style="border-collapse:collapse">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:3px 12px 3px 0;color:#555">${escapeHtml(k)}</td><td style="padding:3px 0"><strong>${escapeHtml(v)}</strong></td></tr>`,
      )
      .join('') +
    `</table></div>`;
  return {
    to,
    subject: `Épicafé : clôture de caisse du ${formatParis(closedAt)}`,
    html,
    text: rows.map(([k, v]) => `${k} : ${v}`).join('\n'),
  };
}
