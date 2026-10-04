import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  householdBalance,
  member,
  membership,
  membershipType,
  sale,
  walletEntry,
  type Db,
} from '@episoft/db';
import type { Config } from '../../config';
import { toParisDate } from '../../lib/dates';

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
    return {
      household: {
        balance: bal?.balance ?? '0.00',
        members,
        membership: current ?? null,
        spentLast12Months: spent,
        wallet: wallet.map((w) => ({ ...w, at: w.at.toISOString() })),
        tickets: tickets.map((s) => ({ ...s, soldAt: s.soldAt.toISOString() })),
      },
    };
  });
};
