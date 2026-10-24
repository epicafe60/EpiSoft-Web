import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  householdBalance,
  loginLog,
  member,
  membership,
  membershipType,
  productReview,
  sale,
  saleLine,
  salePayment,
  walletEntry,
  type Db,
} from '@episoft/db';
import type { Config } from '../../config';
import { toParisDate } from '../../lib/dates';
import { notFound } from '../../lib/problem';

/** Self-service: a member sees their own household, never anyone else's. */
export const selfRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  app.get('/me/household', async (req) => {
    const [me] = await db.select().from(member).where(eq(member.id, req.user!.id));
    const householdId = me?.householdId;
    if (!householdId) return { household: null };
    const [bal] = await db
      .select()
      .from(householdBalance)
      .where(eq(householdBalance.householdId, householdId));
    const members = await db
      .select({ id: member.id, firstName: member.firstName, lastName: member.lastName })
      .from(member)
      .where(eq(member.householdId, householdId));
    const today = toParisDate(new Date());
    const [current] = await db
      .select({
        endDate: membership.endDate,
        typeName: membershipType.label,
      })
      .from(membership)
      .innerJoin(membershipType, eq(membershipType.id, membership.typeId))
      .where(
        and(
          eq(membership.householdId, householdId),
          isNull(membership.cancelledAt),
          gte(membership.endDate, today),
        ),
      )
      .orderBy(desc(membership.endDate))
      .limit(1);
    const wallet = await db
      .select({
        id: walletEntry.id,
        at: walletEntry.at,
        amount: walletEntry.amount,
        kind: walletEntry.kind,
        comment: walletEntry.comment,
        saleId: walletEntry.saleId,
      })
      .from(walletEntry)
      .where(eq(walletEntry.householdId, householdId))
      .orderBy(desc(walletEntry.at))
      .limit(30);
    const tickets = await db
      .select({ id: sale.id, number: sale.number, soldAt: sale.soldAt, total: sale.total })
      .from(sale)
      .where(and(eq(sale.householdId, householdId), isNull(sale.cancelsSaleId)))
      .orderBy(desc(sale.soldAt))
      .limit(20);
    const [{ spent } = { spent: '0' }] = await db
      .select({ spent: sql<string>`coalesce(sum(${sale.total}), 0)::text` })
      .from(sale)
      .where(
        and(eq(sale.householdId, householdId), sql`${sale.soldAt} >= now() - interval '12 months'`),
      );
    // R-EVO-43: the payment methods of each ticket, not only the cagnotte.
    const pays = tickets.length
      ? await db
          .select({ saleId: salePayment.saleId, method: salePayment.method })
          .from(salePayment)
          .where(
            inArray(
              salePayment.saleId,
              tickets.map((s) => s.id),
            ),
          )
      : [];
    return {
      household: {
        balance: bal?.balance ?? '0.00',
        members,
        membership: current ?? null,
        spentLast12Months: spent,
        wallet: wallet.map((w) => ({ ...w, at: w.at.toISOString() })),
        tickets: tickets.map((s) => ({
          ...s,
          soldAt: s.soldAt.toISOString(),
          methods: [...new Set(pays.filter((p) => p.saleId === s.id).map((p) => p.method))],
        })),
      },
    };
  });

  /** One ticket of the member's own household; any other ticket is "not found". */
  app.get(
    '/me/tickets/:id',
    { schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const [me] = await db.select().from(member).where(eq(member.id, req.user!.id));
      const [s] = me?.householdId
        ? await db
            .select()
            .from(sale)
            .where(and(eq(sale.id, req.params.id), eq(sale.householdId, me.householdId)))
        : [];
      if (!s) throw notFound('Ticket introuvable.');
      const lines = await db
        .select({
          label: saleLine.label,
          qty: saleLine.qty,
          unitPrice: saleLine.unitPrice,
          discount: saleLine.discount,
          lineTotal: saleLine.lineTotal,
        })
        .from(saleLine)
        .where(eq(saleLine.saleId, s.id))
        .orderBy(asc(saleLine.lineNo));
      const payments = await db
        .select({ method: salePayment.method, amount: salePayment.amount })
        .from(salePayment)
        .where(eq(salePayment.saleId, s.id));
      return {
        id: s.id,
        number: s.number,
        soldAt: s.soldAt.toISOString(),
        total: s.total,
        status: s.status,
        lines,
        payments,
      };
    },
  );

  /** R-MBR-08: the member's own data as a JSON file (right of access), household included. */
  app.get(
    '/me/export',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const [me] = await db.select().from(member).where(eq(member.id, req.user!.id));
      if (!me) throw notFound('Compte introuvable.');
      const { passwordHash: _p, qrTokenHash: _q, ...profile } = me;
      const hid = me.householdId;
      const wallet = hid
        ? await db
            .select({
              at: walletEntry.at,
              kind: walletEntry.kind,
              amount: walletEntry.amount,
              comment: walletEntry.comment,
            })
            .from(walletEntry)
            .where(eq(walletEntry.householdId, hid))
            .orderBy(desc(walletEntry.at))
        : [];
      const tickets = hid
        ? await db
            .select({ id: sale.id, number: sale.number, soldAt: sale.soldAt, total: sale.total })
            .from(sale)
            .where(eq(sale.householdId, hid))
            .orderBy(desc(sale.soldAt))
        : [];
      const ids = tickets.map((x) => x.id);
      const lines = ids.length
        ? await db
            .select({
              saleId: saleLine.saleId,
              label: saleLine.label,
              qty: saleLine.qty,
              lineTotal: saleLine.lineTotal,
            })
            .from(saleLine)
            .where(inArray(saleLine.saleId, ids))
            .orderBy(saleLine.saleId, saleLine.lineNo)
        : [];
      const memberships = hid
        ? await db
            .select({
              startDate: membership.startDate,
              endDate: membership.endDate,
              amount: membership.amount,
              cancelledAt: membership.cancelledAt,
            })
            .from(membership)
            .where(eq(membership.householdId, hid))
            .orderBy(desc(membership.startDate))
        : [];
      const reviews = await db
        .select({
          rating: productReview.rating,
          comment: productReview.comment,
          status: productReview.status,
          createdAt: productReview.createdAt,
        })
        .from(productReview)
        .where(eq(productReview.memberId, me.id));
      const logins = await db
        .select({ at: loginLog.at, success: loginLog.success, ip: loginLog.ip })
        .from(loginLog)
        .where(eq(loginLog.memberId, me.id))
        .orderBy(desc(loginLog.at))
        .limit(500);
      void reply.header(
        'content-disposition',
        `attachment; filename="mes-donnees-${me.number}.json"`,
      );
      return {
        exportedAt: new Date().toISOString(),
        member: profile,
        memberships,
        wallet,
        tickets: tickets.map(({ id, ...x }) => ({
          ...x,
          lines: lines.filter((l) => l.saleId === id).map(({ saleId: _s, ...l }) => l),
        })),
        reviews,
        logins,
      };
    },
  );
};
