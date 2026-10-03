import { and, eq, isNull, max, sql } from 'drizzle-orm';
import { householdBalance, membership, type DbOrTx } from '@episoft/db';
import { decimalToCents } from '@episoft/shared';

/** R-CAG-03: current balance of a household, in cents. Locks the household's ledger. */
export async function lockedBalanceCents(tx: DbOrTx, householdId: string): Promise<number> {
  // Serialize the writers of one household so two tills cannot both spend the same euros.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'wallet:' + householdId}))`);
  return balanceCents(tx, householdId);
}

export async function balanceCents(db: DbOrTx, householdId: string): Promise<number> {
  const [row] = await db
    .select({ balance: householdBalance.balance })
    .from(householdBalance)
    .where(eq(householdBalance.householdId, householdId));
  return row ? decimalToCents(row.balance) : 0;
}

/** End date of the household's latest valid (not cancelled) membership. */
export async function currentMembershipEnd(
  db: DbOrTx,
  householdId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ end: max(membership.endDate) })
    .from(membership)
    .where(and(eq(membership.householdId, householdId), isNull(membership.cancelledAt)));
  return row?.end ?? null;
}
