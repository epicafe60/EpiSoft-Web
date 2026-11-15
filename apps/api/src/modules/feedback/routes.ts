import { and, asc, desc, eq, ilike, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { feedbackComment, feedbackTicket, member, type Db, type DbOrTx } from '@episoft/db';
import {
  FEEDBACK_CLOSED,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  feedbackCommentSchema,
  feedbackCreateSchema,
  feedbackManageSchema,
  feedbackModuleLabel,
  feedbackQuerySchema,
  formatFeedbackNumber,
  hasAnyRole,
  isFeedbackClosed,
  type FeedbackComment,
  type FeedbackDetail,
  type FeedbackRow,
} from '@episoft/shared';
import type { Config } from '../../config';
import { notifyStaff } from '../../lib/alerts';
import { audit } from '../../lib/audit';
import { queueTemplatedEmail } from '../../lib/email-render';
import { notFound } from '../../lib/problem';
import { canLogIn } from '../../plugins/auth';
import { nextNumber } from '../pos/numbers';

const idParams = z.object({ id: z.string().uuid() });

const authorName = sql<string | null>`${member.firstName} || ' ' || ${member.lastName}`;

const rowSelect = {
  id: feedbackTicket.id,
  number: feedbackTicket.number,
  kind: feedbackTicket.kind,
  module: feedbackTicket.module,
  screen: feedbackTicket.screen,
  title: feedbackTicket.title,
  status: feedbackTicket.status,
  priority: feedbackTicket.priority,
  authorId: feedbackTicket.authorId,
  authorName,
  createdAt: feedbackTicket.createdAt,
  updatedAt: feedbackTicket.updatedAt,
  closedAt: feedbackTicket.closedAt,
};

type Row = Omit<FeedbackRow, 'number' | 'createdAt' | 'updatedAt' | 'closedAt'> & {
  number: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

const toRow = (r: Row): FeedbackRow => ({
  ...r,
  number: formatFeedbackNumber(r.number),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  closedAt: r.closedAt?.toISOString() ?? null,
});

/** Tells the author, by e-mail, that the team answered or changed the state of their report. */
async function tellAuthor(
  tx: DbOrTx,
  t: { authorId: string | null; number: number; title: string },
  what: { kind: 'reply'; message: string } | { kind: 'status'; state: string },
) {
  if (!t.authorId) return;
  const [a] = await tx
    .select({ email: member.email, firstName: member.firstName, status: member.status })
    .from(member)
    .where(eq(member.id, t.authorId));
  if (!a?.email || !canLogIn(a.status)) return;
  const common = { prenom: a.firstName, numero: formatFeedbackNumber(t.number), titre: t.title };
  if (what.kind === 'reply')
    await queueTemplatedEmail(tx, 'feedback_reply', a.email, { ...common, message: what.message });
  else await queueTemplatedEmail(tx, 'feedback_status', a.email, { ...common, etat: what.state });
}

/**
 * Signalements: any signed-in person reports a bug or an idea from the screen they are on; the
 * author follows their own reports, the administrators handle them all.
 */
export const feedbackRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const admin = { preHandler: app.requireRoles('ADMIN') };
  const isAdmin = (req: FastifyRequest) => hasAnyRole(req.user!.roles, ['ADMIN']);

  /** The report, if the person may read it (their own, or any for an administrator). */
  async function readable(tx: DbOrTx, req: FastifyRequest, id: string) {
    const [t] = await tx.select().from(feedbackTicket).where(eq(feedbackTicket.id, id));
    // Someone else's report is « not found », not « forbidden »: it is not even confirmed to exist.
    if (!t || (t.authorId !== req.user!.id && !isAdmin(req)))
      throw notFound('Signalement introuvable.');
    return t;
  }

  app.post(
    '/feedback',
    {
      schema: { body: feedbackCreateSchema },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req) => {
      const b = req.body;
      const created = await db.transaction(async (tx) => {
        const number = await nextNumber(tx, 'feedback');
        const [t] = await tx
          .insert(feedbackTicket)
          .values({
            number,
            kind: b.kind,
            module: b.module,
            screen: b.screen,
            title: b.title,
            description: b.description,
            steps: b.steps,
            // The roles are the server's, not the page's.
            context: { ...b.context, roles: req.user!.roles },
            authorId: req.user!.id,
          })
          .returning({ id: feedbackTicket.id, number: feedbackTicket.number });
        await audit(tx, req, {
          action: 'feedback.create',
          entity: 'feedback_ticket',
          entityId: t!.id,
          after: {
            number: formatFeedbackNumber(number),
            kind: b.kind,
            module: b.module,
            title: b.title,
          },
        });
        return t!;
      });
      // The administrators are told (e-mail and push); a failure never loses the report.
      void notifyStaff(
        db,
        config,
        ['ADMIN'],
        {
          template: 'feedback_new',
          values: {
            numero: formatFeedbackNumber(created.number),
            type: FEEDBACK_KIND_LABELS[b.kind],
            module: feedbackModuleLabel(b.module),
            titre: b.title,
            auteur: `${req.user!.firstName} ${req.user!.lastName}`,
          },
        },
        { title: 'Nouveau signalement', body: b.title, url: '/signalements/gestion' },
        req.log,
      ).catch((e) => req.log.error({ err: e }, 'signalement non notifié'));
      return { id: created.id, number: formatFeedbackNumber(created.number) };
    },
  );

  app.get('/feedback/mine', async (req): Promise<FeedbackRow[]> => {
    const rows = await db
      .select(rowSelect)
      .from(feedbackTicket)
      .leftJoin(member, eq(member.id, feedbackTicket.authorId))
      .where(eq(feedbackTicket.authorId, req.user!.id))
      .orderBy(desc(feedbackTicket.createdAt))
      .limit(200);
    return rows.map((r) => toRow(r));
  });

  app.get(
    '/feedback',
    { ...admin, schema: { querystring: feedbackQuerySchema } },
    async (req): Promise<FeedbackRow[]> => {
      const q = req.query;
      const f: SQL[] = [];
      if (q.status) f.push(eq(feedbackTicket.status, q.status));
      if (q.kind) f.push(eq(feedbackTicket.kind, q.kind));
      if (q.module) f.push(eq(feedbackTicket.module, q.module));
      if (q.open === 'true') f.push(notInArray(feedbackTicket.status, [...FEEDBACK_CLOSED]));
      if (q.open === 'false') f.push(inArray(feedbackTicket.status, [...FEEDBACK_CLOSED]));
      if (q.q) {
        // Escaped: the text of the search is never a pattern of its own.
        const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
        f.push(
          or(
            ilike(feedbackTicket.title, like),
            ilike(feedbackTicket.description, like),
            sql`'SIG-' || lpad(${feedbackTicket.number}::text, 4, '0') ilike ${like}`,
          )!,
        );
      }
      const rows = await db
        .select(rowSelect)
        .from(feedbackTicket)
        .leftJoin(member, eq(member.id, feedbackTicket.authorId))
        .where(and(...f))
        // Open ones first, the most urgent and the oldest on top.
        .orderBy(
          sql`(${feedbackTicket.status} in ('DONE', 'REFUSED', 'DUPLICATE'))`,
          sql`case ${feedbackTicket.priority} when 'HIGH' then 0 when 'NORMAL' then 1 else 2 end`,
          asc(feedbackTicket.createdAt),
        )
        .limit(q.limit);
      return rows.map((r) => toRow(r));
    },
  );

  app.get(
    '/feedback/:id',
    { schema: { params: idParams } },
    async (req): Promise<FeedbackDetail> => {
      const t = await readable(db, req, req.params.id);
      const [row] = await db
        .select(rowSelect)
        .from(feedbackTicket)
        .leftJoin(member, eq(member.id, feedbackTicket.authorId))
        .where(eq(feedbackTicket.id, t.id));
      const comments = await db
        .select({
          id: feedbackComment.id,
          authorId: feedbackComment.authorId,
          authorName,
          fromTeam: feedbackComment.fromTeam,
          body: feedbackComment.body,
          createdAt: feedbackComment.createdAt,
        })
        .from(feedbackComment)
        .leftJoin(member, eq(member.id, feedbackComment.authorId))
        .where(eq(feedbackComment.ticketId, t.id))
        .orderBy(asc(feedbackComment.createdAt));
      return {
        ...toRow(row as Row),
        description: t.description,
        steps: t.steps,
        context: t.context as FeedbackDetail['context'],
        comments: comments.map((c): FeedbackComment => ({
          ...c,
          createdAt: c.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/feedback/:id/comments',
    {
      schema: { params: idParams, body: feedbackCommentSchema },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      await db.transaction(async (tx) => {
        const t = await readable(tx, req, req.params.id);
        const fromTeam = isAdmin(req) && t.authorId !== req.user!.id;
        await tx.insert(feedbackComment).values({
          ticketId: t.id,
          authorId: req.user!.id,
          fromTeam,
          body: req.body.body,
        });
        // The author answering a closed report reopens the conversation: it comes back as « Nouveau ».
        if (!fromTeam && isFeedbackClosed(t.status))
          await tx
            .update(feedbackTicket)
            .set({ status: 'NEW', closedAt: null })
            .where(eq(feedbackTicket.id, t.id));
        else
          await tx
            .update(feedbackTicket)
            .set({ updatedAt: new Date() })
            .where(eq(feedbackTicket.id, t.id));
        if (fromTeam) await tellAuthor(tx, t, { kind: 'reply', message: req.body.body });
        await audit(tx, req, {
          action: 'feedback.comment',
          entity: 'feedback_ticket',
          entityId: t.id,
          after: { number: formatFeedbackNumber(t.number), fromTeam },
        });
      });
      return reply.status(204).send();
    },
  );

  app.patch(
    '/feedback/:id',
    { ...admin, schema: { params: idParams, body: feedbackManageSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(feedbackTicket)
          .where(eq(feedbackTicket.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Signalement introuvable.');
        const { status, priority } = req.body;
        const closing = status !== undefined && isFeedbackClosed(status);
        const [after] = await tx
          .update(feedbackTicket)
          .set({
            ...(status === undefined ? {} : { status }),
            ...(priority === undefined ? {} : { priority }),
            ...(status === undefined
              ? {}
              : { closedAt: closing ? (before.closedAt ?? new Date()) : null }),
            updatedAt: new Date(),
          })
          .where(eq(feedbackTicket.id, before.id))
          .returning();
        if (status !== undefined && status !== before.status)
          await tellAuthor(tx, before, { kind: 'status', state: FEEDBACK_STATUS_LABELS[status] });
        await audit(tx, req, {
          action: 'feedback.update',
          entity: 'feedback_ticket',
          entityId: before.id,
          before: {
            number: formatFeedbackNumber(before.number),
            status: before.status,
            priority: before.priority,
          },
          after: {
            number: formatFeedbackNumber(before.number),
            status: after!.status,
            priority: after!.priority,
          },
        });
        return { status: after!.status, priority: after!.priority };
      }),
  );
};
