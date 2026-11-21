import { statfs } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@episoft/db';
import { dbSizeSnapshot } from '@episoft/db';
import { addDays } from '@episoft/shared';
import { toShopDate } from '../../../lib/dates';

// Size of the database and of the disk (ADR 0017): what the Administration › Base de données screen
// shows, what the « À surveiller » alerts read, and the weekly snapshot of the growth curve.

export interface TableSize {
  name: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  rows: number;
  deadRows: number;
  lastAutovacuum: string | null;
}

export async function totalDatabaseBytes(db: DbOrTx): Promise<number> {
  const r = await db.execute<{ n: string }>(
    sql`select pg_database_size(current_database())::text as n`,
  );
  return Number(r.rows[0]!.n);
}

/** Every table of the schema, the biggest first (data and TOAST, then indexes). */
export async function tableSizes(db: DbOrTx): Promise<TableSize[]> {
  const r = await db.execute<{
    name: string;
    total: string;
    idx: string;
    live: string | null;
    dead: string | null;
    vac: string | null;
  }>(sql`
    select c.relname::text as name,
           pg_total_relation_size(c.oid)::text as total,
           pg_indexes_size(c.oid)::text as idx,
           s.n_live_tup::text as live, s.n_dead_tup::text as dead,
           coalesce(s.last_autovacuum, s.last_vacuum)::text as vac
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s on s.relid = c.oid
     where n.nspname = 'app' and c.relkind in ('r', 'p')
     order by pg_total_relation_size(c.oid) desc`);
  return r.rows.map((x) => ({
    name: x.name,
    totalBytes: Number(x.total),
    indexBytes: Number(x.idx),
    tableBytes: Number(x.total) - Number(x.idx),
    rows: Number(x.live ?? 0),
    deadRows: Number(x.dead ?? 0),
    lastAutovacuum: x.vac,
  }));
}

export type SnapshotReason = 'weekly' | 'before_purge' | 'after_purge';

/** Stores the size of the database and of its 15 biggest tables. */
export async function takeSizeSnapshot(db: DbOrTx, reason: SnapshotReason): Promise<void> {
  const tables = (await tableSizes(db)).slice(0, 15);
  await db
    .insert(dbSizeSnapshot)
    .values({ totalBytes: await totalDatabaseBytes(db), tables, reason });
}

/** One snapshot a week (Monday's slot in job_run), whichever job tick comes first. */
export async function weeklySnapshot(db: Db, now: Date): Promise<boolean> {
  const day = toShopDate(now);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(day, -((dow + 6) % 7));
  const res = await db.execute(
    sql`insert into app.job_run (name, day) values ('db-size-weekly', ${monday}::date) on conflict do nothing`,
  );
  if (!res.rowCount) return false;
  await takeSizeSnapshot(db, 'weekly');
  return true;
}

export interface DiskSpace {
  totalBytes: number;
  freeBytes: number;
  freePct: number;
  path: string;
}

/**
 * Free space of the disk the server runs on (DISK_CHECK_PATH, default: where it was started). It is
 * the disk of the database when PostgreSQL runs on the same machine, which is the case in
 * production; null where the system cannot say.
 */
export async function diskSpace(): Promise<DiskSpace | null> {
  const path = process.env.DISK_CHECK_PATH || process.cwd();
  try {
    const s = await statfs(path);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    return { totalBytes: total, freeBytes: free, freePct: (free / total) * 100, path };
  } catch {
    return null;
  }
}
