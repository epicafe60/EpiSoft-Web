import { eq, sql } from 'drizzle-orm';
import {
  member,
  productFavorite,
  productReview,
  pushSubscription,
  session,
  userRole,
  type Tx,
} from '@episoft/db';

/**
 * R-MBR-08: anonymisation of a member, amounts kept for the accounts. Shared by the administrator's
 * button and by the automatic anonymisation of inactive members (ADR 0017, spec Q8).
 * Runs inside the caller's transaction; `record` writes the journal entry of the action, before the
 * journals are scrubbed (so that the entry itself carries no personal value).
 */
export async function anonymizeMember(
  tx: Tx,
  m: { id: string; number: number },
  record: () => Promise<void>,
): Promise<void> {
  await tx.delete(userRole).where(eq(userRole.memberId, m.id));
  await tx.delete(session).where(eq(session.memberId, m.id));
  // Free-text reviews and devices are personal data too.
  await tx.delete(productReview).where(eq(productReview.memberId, m.id));
  await tx.delete(productFavorite).where(eq(productFavorite.memberId, m.id));
  await tx.delete(pushSubscription).where(eq(pushSubscription.memberId, m.id));
  await tx
    .update(member)
    .set({
      lastName: `Membre #${m.number}`,
      firstName: '-',
      street: null,
      postcode: null,
      communeId: null,
      phone: null,
      email: null,
      username: null,
      passwordHash: null,
      qrTokenHash: null,
      tillPasswordHash: null,
      tillPasswordSalt: null,
      newsletterOptInAt: null,
      publicVisible: false,
      status: 'ARCHIVED',
    })
    .where(eq(member.id, m.id));
  await record();
  // R-MBR-08: the journals keep that something changed, not the personal values.
  await tx.execute(sql`select app.scrub_member(${m.id}::uuid)`);
}
