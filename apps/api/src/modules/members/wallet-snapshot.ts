import { sql } from 'drizzle-orm';
import type { Db } from '@episoft/db';
import { toParisDate } from '../../lib/dates';

/**
 * Notes the balance of every cagnotte as it stood at the start of today (Paris). The nightly
 * check CAG-05 then verifies « that balance + the movements since = the balance now »: a
 * movement added, changed or removed in the past breaks it, and nobody can do that quietly.
 * One note per household and day; running it twice changes nothing. Returns the rows written.
 */
export async function takeWalletSnapshot(db: Db, now = new Date()): Promise<number> {
  const day = toParisDate(now);
  const res = await db.execute(sql`
    insert into app.wallet_snapshot (day, household_id, balance)
    select ${day}::date, w.household_id, sum(w.amount)
    from app.wallet_entry w
    -- Recording time, not the sale time: a ticket made offline yesterday evening and received
    -- this morning belongs to « since the snapshot ».
    where w.created_at < (${day}::date::timestamp at time zone 'Europe/Paris')
    group by w.household_id
    on conflict do nothing`);
  return res.rowCount ?? 0;
}
