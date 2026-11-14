import { and, eq, gt, or, sql } from 'drizzle-orm';
import { posDevice, type DbOrTx } from '@episoft/db';

// Audit KV2, C02/C04: which tills may still hold sales the server has not received.

/** A till silent for longer than this, while in use, may be selling offline. */
export const SILENT_MINUTES = 10;
/** A till not heard of for this long is considered put away, not in use. */
export const IN_USE_HOURS = 12;

/** The till says it is there, and how many operations it still holds. */
export async function noteDeviceContact(
  db: DbOrTx,
  deviceId: string,
  pending: number,
  /** The last operation number the till created (absent from an older till). */
  seq?: number,
): Promise<void> {
  await db
    .update(posDevice)
    .set({
      lastContactAt: new Date(),
      pendingOps: pending,
      ...(seq === undefined ? {} : { announcedSeq: seq }),
    })
    .where(eq(posDevice.id, deviceId));
}

/**
 * The active tills in use today (heard of in the last IN_USE_HOURS) that either announced
 * operations still to send, or have been silent for more than SILENT_MINUTES: they may be selling
 * offline. A till put away (silent for days) is not in the list.
 */
export async function unsyncedTills(db: DbOrTx): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: posDevice.id, name: posDevice.name })
    .from(posDevice)
    .where(
      and(
        eq(posDevice.active, true),
        gt(posDevice.lastContactAt, sql`now() - ${IN_USE_HOURS} * interval '1 hour'`),
        or(
          gt(posDevice.pendingOps, 0),
          // F5: the till's own numbering shows operations the server has not received.
          gt(posDevice.announcedSeq, posDevice.receivedSeq),
          sql`${posDevice.lastContactAt} < now() - ${SILENT_MINUTES} * interval '1 minute'`,
        ),
      ),
    )
    .orderBy(posDevice.name);
}
