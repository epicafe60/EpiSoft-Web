import { timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  backupRun,
  emailOutbox,
  auditLog,
  errorLog,
  integrityRun,
  member,
  jobRun,
  posDevice,
  sale,
  syncRejection,
  type Db,
} from '@episoft/db';
import type { Config } from '../../config';
import {
  describeAudit,
  EMAIL_STATUSES,
  type EmailDetail,
  type EmailLog,
  type MailSender,
} from '@episoft/shared';
import { audit } from '../../lib/audit';
import { EMAIL_DISABLED_NOTE, type EmailAttachment } from '../../lib/mail';
import { notFound, unauthorized } from '../../lib/problem';
import { computeAttention } from './attention';
import { loadSettings } from './settings-store';

const idParams = { params: z.object({ id: z.string().uuid() }) };

/** Loopback or private network address (IPv4, IPv6, or IPv4 mapped in IPv6). */
export function isLocalAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^127\./.test(v4) || v4 === '::1' || /^10\./.test(v4) || /^192\.168\./.test(v4)) return true;
  const m = /^172\.(\d+)\./.exec(v4);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/**
 * What the responsables need to follow the health of the application: the « À surveiller »
 * list, refused tickets, tickets saved with a warning, unexpected errors, failed e-mails and the
 * reports of the backup scripts.
 */
export const monitoringRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const staff = { preHandler: app.requireRoles('ADMIN', 'COMPTA') };
  const admin = { preHandler: app.requireRoles('ADMIN') };

  /** The alert thresholds, for the screens that warn before a mistake (till, receipts…). */
  app.get('/controls/thresholds', async () => (await loadSettings(db))['controls.thresholds']);

  app.get('/admin/attention', staff, async (req) => {
    const items = await computeAttention(db, (await loadSettings(db))['controls.thresholds']);
    // The server errors page is for the administrators: the treasury does not get a dead link.
    return req.user!.roles.includes('ADMIN')
      ? items
      : items.filter((i) => i.code !== 'SERVER_ERRORS');
  });

  // --- What changed lately ----------------------------------------------------------------------

  /** The last changes, in plain sentences, for the people who look after the shop. */
  app.get(
    '/admin/activity',
    {
      ...staff,
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }),
      },
    },
    async (req) => {
      const rows = await db
        .select({
          id: auditLog.id,
          at: auditLog.at,
          action: auditLog.action,
          after: auditLog.after,
          actor: sql<string | null>`${member.firstName} || ' ' || ${member.lastName}`,
          onBehalfOf: sql<
            string | null
          >`(select m2.first_name || ' ' || m2.last_name from app.member m2 where m2.id = ${auditLog.onBehalfOfId})`,
        })
        .from(auditLog)
        .leftJoin(member, eq(member.id, auditLog.actorId))
        .where(sql`${auditLog.action} not in ('error', 'member.export')`)
        .orderBy(desc(auditLog.id))
        .limit(req.query.limit);
      return rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: r.actor ?? 'Le système',
        onBehalfOf: r.onBehalfOf,
        sentence: describeAudit(r.action, r.after),
      }));
    },
  );

  // --- Refused tickets ------------------------------------------------------------------------

  app.get(
    '/admin/rejections',
    {
      ...staff,
      schema: { querystring: z.object({ all: z.enum(['true']).optional() }) },
    },
    async (req) => {
      const rows = await db
        .select({
          id: syncRejection.id,
          at: syncRejection.at,
          kind: syncRejection.kind,
          reason: syncRejection.reason,
          payload: syncRejection.payload,
          acknowledgedAt: syncRejection.acknowledgedAt,
          deviceName: posDevice.name,
        })
        .from(syncRejection)
        .leftJoin(posDevice, eq(posDevice.id, syncRejection.deviceId))
        .where(req.query.all ? undefined : isNull(syncRejection.acknowledgedAt))
        .orderBy(desc(syncRejection.at))
        .limit(200);
      return rows.map((r) => ({
        ...r,
        at: r.at.toISOString(),
        acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      }));
    },
  );

  app.post('/admin/rejections/:id/ack', { ...staff, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [r] = await tx
        .update(syncRejection)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: req.user!.id })
        .where(and(eq(syncRejection.id, req.params.id), isNull(syncRejection.acknowledgedAt)))
        .returning({ id: syncRejection.id, reason: syncRejection.reason });
      if (!r) throw notFound('Ticket refusé introuvable ou déjà classé.');
      await audit(tx, req, {
        action: 'rejection.ack',
        entity: 'sync_rejection',
        entityId: r.id,
        after: { reason: r.reason },
      });
      return { ok: true };
    }),
  );

  // --- Tickets saved with a warning ------------------------------------------------------------

  app.get('/admin/sale-warnings', staff, async () => {
    const rows = await db
      .select({
        id: sale.id,
        number: sale.number,
        soldAt: sale.soldAt,
        total: sale.total,
        warnings: sale.warnings,
        deviceName: posDevice.name,
      })
      .from(sale)
      .leftJoin(posDevice, eq(posDevice.id, sale.deviceId))
      .where(
        and(
          sql`${sale.warnings} is not null and jsonb_array_length(${sale.warnings}) > 0`,
          isNull(sale.warningsReviewedAt),
          gt(sale.soldAt, new Date(Date.now() - 30 * 86_400_000)),
        ),
      )
      .orderBy(desc(sale.soldAt))
      .limit(200);
    return rows.map((r) => ({
      ...r,
      soldAt: r.soldAt.toISOString(),
      warnings: (r.warnings ?? []) as { code: string; message: string }[],
    }));
  });

  app.post('/admin/sale-warnings/:id/review', { ...staff, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [r] = await tx
        .update(sale)
        .set({ warningsReviewedAt: new Date() })
        .where(and(eq(sale.id, req.params.id), isNull(sale.warningsReviewedAt)))
        .returning({ id: sale.id, number: sale.number });
      if (!r) throw notFound('Ticket introuvable ou déjà examiné.');
      await audit(tx, req, {
        action: 'sale.warnings_reviewed',
        entity: 'sale',
        entityId: r.id,
        after: { number: r.number },
      });
      return { ok: true };
    }),
  );

  // --- Unexpected errors -----------------------------------------------------------------------

  // Technical messages: for the administrators only.
  app.get('/admin/errors', admin, async () => {
    const rows = await db.select().from(errorLog).orderBy(desc(errorLog.lastAt)).limit(100);
    return rows.map((r) => ({
      id: r.id,
      message: r.message,
      route: r.route,
      count: r.count,
      firstAt: r.firstAt.toISOString(),
      lastAt: r.lastAt.toISOString(),
      lastRef: r.lastRef,
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    }));
  });

  app.post('/admin/errors/:id/ack', { ...admin, schema: idParams }, async (req) => {
    const [r] = await db
      .update(errorLog)
      .set({ acknowledgedAt: new Date() })
      .where(eq(errorLog.id, req.params.id))
      .returning({ id: errorLog.id, ref: errorLog.lastRef });
    if (!r) throw notFound('Erreur introuvable.');
    await audit(db, req, {
      action: 'error.ack',
      entity: 'error_log',
      entityId: r.id,
      after: { ref: r.ref },
    });
    return { ok: true };
  });

  // --- E-mails that did not leave --------------------------------------------------------------

  /**
   * The journal of every e-mail the application wrote, sent or not, newest first: « Envoyé »,
   * « En attente » or « Non envoyé » (sending switched off, or refused by the mail server).
   * Bodies are not returned: they may hold personal data.
   */
  app.get(
    '/admin/emails',
    {
      ...staff,
      schema: {
        querystring: z.object({
          status: z.enum(EMAIL_STATUSES).optional(),
          /** Id of the last entry already shown (UUID v7 ids are time-ordered). */
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req): Promise<EmailLog> => {
      const q = req.query;
      const rows = await db
        .select({
          id: emailOutbox.id,
          to: emailOutbox.to,
          subject: emailOutbox.subject,
          status: emailOutbox.status,
          lastError: emailOutbox.lastError,
          attempts: emailOutbox.attempts,
          createdAt: emailOutbox.createdAt,
          sentAt: emailOutbox.sentAt,
          attachments: sql<string[]>`coalesce((
            select jsonb_agg(a ->> 'filename')
            from jsonb_array_elements(case when jsonb_typeof(${emailOutbox.attachments}) = 'array'
                                           then ${emailOutbox.attachments} else '[]'::jsonb end) a), '[]'::jsonb)`,
        })
        .from(emailOutbox)
        .where(
          and(
            q.status ? eq(emailOutbox.status, q.status) : undefined,
            q.cursor ? lt(emailOutbox.id, q.cursor) : undefined,
          ),
        )
        .orderBy(desc(emailOutbox.id))
        .limit(q.limit);
      const counted = await db
        .select({ status: emailOutbox.status, n: sql<number>`count(*)::int` })
        .from(emailOutbox)
        .groupBy(emailOutbox.status);
      const counts = { SENT: 0, PENDING: 0, FAILED: 0 };
      for (const c of counted) counts[c.status] = c.n;
      return {
        sendingEnabled: (await loadSettings(db))['email.enabled'].enabled,
        counts,
        rows: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          sentAt: r.sentAt?.toISOString() ?? null,
        })),
      };
    },
  );

  /** Before writing an e-mail: who it will come from, and whether anything will leave. */
  app.get(
    '/mail/sender',
    { preHandler: app.requireRoles('ADMIN', 'COMPTA', 'APPROS') },
    async (): Promise<MailSender> => ({
      from: config.SMTP_FROM,
      smtpConfigured: !!config.SMTP_HOST,
      sendingEnabled: (await loadSettings(db))['email.enabled'].enabled,
    }),
  );

  /**
   * « Aperçu » of one e-mail of the journal: to, from, subject, text, HTML and attachments. The
   * text may hold personal data: looking at it is recorded in the journal of changes.
   */
  app.get(
    '/admin/emails/:id',
    { ...staff, schema: idParams },
    async (req): Promise<EmailDetail> => {
      const [m] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, req.params.id));
      if (!m) throw notFound('Courriel introuvable.');
      const files = attachmentsOf(m.attachments);
      await audit(db, req, {
        action: 'email.view',
        entity: 'email_outbox',
        entityId: m.id,
        after: { to: m.to, subject: m.subject },
      });
      return {
        id: m.id,
        to: m.to,
        subject: m.subject,
        status: m.status,
        lastError: m.lastError,
        attempts: m.attempts,
        createdAt: m.createdAt.toISOString(),
        sentAt: m.sentAt?.toISOString() ?? null,
        attachments: files.map((f) => f.filename),
        from: config.SMTP_FROM,
        text: m.text,
        html: m.html,
        files: files.map((f, index) => ({
          index,
          filename: f.filename,
          contentType: f.contentType,
          sizeBytes: Buffer.from(f.contentBase64, 'base64').length,
        })),
      };
    },
  );

  app.get(
    '/admin/emails/:id/attachments/:index',
    {
      ...staff,
      schema: {
        params: z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0) }),
      },
    },
    async (req, reply) => {
      const [m] = await db
        .select({ attachments: emailOutbox.attachments })
        .from(emailOutbox)
        .where(eq(emailOutbox.id, req.params.id));
      const file = m ? attachmentsOf(m.attachments)[req.params.index] : undefined;
      if (!file) throw notFound('Pièce jointe introuvable.');
      return reply
        .header(
          'content-disposition',
          `inline; filename="${file.filename.replace(/[^\w.\- ]+/g, '_')}"`,
        )
        .type(file.contentType)
        .send(Buffer.from(file.contentBase64, 'base64'));
    },
  );

  app.get('/admin/emails/failed', staff, async () => {
    const rows = await db
      .select({
        id: emailOutbox.id,
        to: emailOutbox.to,
        subject: emailOutbox.subject,
        status: emailOutbox.status,
        lastError: emailOutbox.lastError,
        createdAt: emailOutbox.createdAt,
      })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.status, 'FAILED'),
          sql`${emailOutbox.lastError} is distinct from ${EMAIL_DISABLED_NOTE}`,
        ),
      )
      .orderBy(desc(emailOutbox.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  });

  app.post('/admin/emails/:id/resend', { ...staff, schema: idParams }, async (req) => {
    await db.transaction(async (tx) => {
      const [r] = await tx
        .update(emailOutbox)
        .set({ status: 'PENDING', attempts: 0, lastError: null })
        .where(and(eq(emailOutbox.id, req.params.id), eq(emailOutbox.status, 'FAILED')))
        .returning({ id: emailOutbox.id, subject: emailOutbox.subject });
      if (!r) throw notFound('Courriel introuvable ou déjà reparti.');
      await audit(tx, req, {
        action: 'email.resend',
        entity: 'email_outbox',
        entityId: r.id,
        after: { subject: r.subject },
      });
    });
    return { ok: true };
  });

  // --- Backups -----------------------------------------------------------------------------------

  /** Reported by deploy/db/backup.sh and restore-test.sh with the shared secret. */
  app.post(
    '/internal/backup-report',
    {
      config: { public: true },
      schema: {
        body: z.object({
          kind: z.enum(['BACKUP', 'RESTORE_TEST']),
          ok: z.boolean(),
          sizeBytes: z.number().int().nonnegative().nullish(),
          checksum: z.string().max(200).nullish(),
          verified: z.boolean().default(false),
          offsite: z.boolean().default(false),
          detail: z.string().max(2000).nullish(),
        }),
      },
    },
    async (req, reply) => {
      // The scripts run on the server: a request from the Internet (through the proxy) is refused
      // before the token is even looked at.
      if (!isLocalAddress(req.ip)) throw notFound('Introuvable.');
      const expected = config.BACKUP_REPORT_TOKEN;
      const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!expected) throw notFound('Le compte rendu de sauvegarde n’est pas activé.');
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized('Jeton invalide.');
      await db.transaction(async (tx) => {
        await tx.insert(backupRun).values({ ...req.body, sizeBytes: req.body.sizeBytes ?? null });
        await audit(tx, req, {
          action: 'backup.report',
          entity: 'backup_run',
          after: { kind: req.body.kind, ok: req.body.ok, sizeBytes: req.body.sizeBytes ?? null },
        });
      });
      return reply.status(204).send();
    },
  );

  app.get('/admin/backups', staff, async () => {
    const rows = await db.select().from(backupRun).orderBy(desc(backupRun.at)).limit(60);
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  });

  // --- Deep health -----------------------------------------------------------------------------

  /** For the administrators: is every part of the application doing its job? */
  app.get('/admin/health', admin, async () => {
    await db.execute(sql`select 1`);
    const [integrity] = await db
      .select()
      .from(integrityRun)
      .orderBy(desc(integrityRun.at))
      .limit(1);
    const jobs = await db
      .select({ name: jobRun.name, day: sql<string>`max(${jobRun.day})::text` })
      .from(jobRun)
      .groupBy(jobRun.name);
    return {
      database: true,
      smtpConfigured: !!config.SMTP_HOST,
      lastIntegrityAt: integrity?.at.toISOString() ?? null,
      jobs,
    };
  });
};

/** The attachments of an outbox row (a JSON array, or nothing). */
function attachmentsOf(value: unknown): EmailAttachment[] {
  return Array.isArray(value) ? (value as EmailAttachment[]) : [];
}
