import { createWriteStream, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { constants as zlibConstants, createGzip } from 'node:zlib';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@episoft/db';
import {
  AUDIT_GROUP_CLASS,
  auditGroupOf,
  changeClassOf,
  RETENTION_CLASSES,
  retentionCutoff,
  type RetentionSettings,
} from '@episoft/shared';
import { takeSizeSnapshot, totalDatabaseBytes } from './size';

// The purge engine (ADR 0017). The deletions themselves are done by app.retention_run() (migration
// 0041), a closed list of kinds written once in SQL: the count of the preview and the deletion
// share their predicate. This file decides WHAT to ask (classes, cutoffs, keys), loops in small
// batches (one transaction each, nothing held between them) and archives what goes.

/** Class → the SQL kinds it purges, in the order they are purged. */
export const CLASS_KINDS: Record<string, string[]> = {
  email_body: ['email_body'],
  email_rows: ['email_rows'],
  error_log: ['error_log'],
  sync_receipt: ['sync_receipt'],
  sync_rejection: ['sync_rejection'],
  job_run: ['job_run'],
  integrity_run: ['integrity_run'],
  wallet_snapshot: ['wallet_snapshot'],
  backup_run: ['backup_run'],
  till_pin_attempt: ['till_pin_attempt'],
  expired_sessions: ['session', 'password_reset_token'],
  login_log: ['login_log'],
  feedback: ['feedback'],
  price_history: ['price_history'],
  audit_security: ['audit_log'],
  audit_other: ['audit_log'],
  audit_sales: ['audit_log'],
  audit_accounting: ['audit_log'],
  data_change_other: ['data_change'],
  data_change_sales: ['data_change'],
  data_change_accounting: ['data_change'],
};

export interface PlanItem {
  classId: string;
  label: string;
  kind: string;
  /** audit_log: the actions of the class; data_change: its tables. */
  keys: string[];
  cutoff: Date;
  rows: number;
  /** Size of the data concerned (not of the indexes: the real gain is a little larger). */
  bytes: number;
}

export interface PlanClass {
  classId: string;
  label: string;
  cutoff: Date | null;
  rows: number;
  bytes: number;
}

const BATCH = 2000;

/** The actions of the audit journal (and the tables of the journal of changes) of each class. */
export async function classKeys(db: Db | Tx): Promise<Record<string, string[]>> {
  const keys: Record<string, string[]> = {};
  const actions = await db.execute<{ action: string }>(
    sql`select distinct action from app.audit_log`,
  );
  for (const r of actions.rows) {
    const id = AUDIT_GROUP_CLASS[auditGroupOf(r.action)];
    (keys[id] ??= []).push(r.action);
  }
  const tables = await db.execute<{ name: string }>(
    sql`select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'app' and c.relkind in ('r', 'p')`,
  );
  for (const r of tables.rows) (keys[changeClassOf(r.name)] ??= []).push(r.name);
  return keys;
}

const arrayParam = (keys: string[]) =>
  sql`array(select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`;

async function retentionRun(
  tx: Db | Tx,
  kind: string,
  cutoff: Date,
  batch: number,
  mode: 'count' | 'purge' | 'archive',
  keys: string[],
) {
  const res = await tx.execute<{
    n: string;
    bytes: string;
    removed: { table: string; row: unknown }[] | null;
  }>(
    sql`select * from app.retention_run(${kind}, ${cutoff.toISOString()}::timestamptz, ${batch}::int, ${mode}, ${arrayParam(keys)})`,
  );
  return res.rows[0]!;
}

/**
 * What a purge would remove now (the dry run): rows and size per class, with the cutoff. Nothing
 * is changed. `only` limits it to some classes.
 */
export async function buildPlan(
  db: Db,
  settings: RetentionSettings,
  now: Date,
  only?: string[],
): Promise<PlanItem[]> {
  const keys = await classKeys(db);
  const items: PlanItem[] = [];
  for (const c of RETENTION_CLASSES) {
    if (only && !only.includes(c.id)) continue;
    const value = settings.durations[c.id as keyof typeof settings.durations] as number | null;
    const cutoff = retentionCutoff(now, value, c.unit);
    if (!cutoff) continue;
    for (const kind of CLASS_KINDS[c.id] ?? []) {
      const k = keys[c.id] ?? [];
      // A journal class with nothing to name (no action or table of it exists): nothing to purge.
      if ((kind === 'audit_log' || kind === 'data_change') && !k.length) continue;
      const r = await retentionRun(db, kind, cutoff, 1, 'count', k);
      items.push({
        classId: c.id,
        label: c.label,
        kind,
        keys: k,
        cutoff,
        rows: Number(r.n),
        bytes: Number(r.bytes),
      });
    }
  }
  return items;
}

export function planByClass(items: PlanItem[]): PlanClass[] {
  const out = new Map<string, PlanClass>();
  for (const i of items) {
    const c = out.get(i.classId) ?? {
      classId: i.classId,
      label: i.label,
      cutoff: i.cutoff,
      rows: 0,
      bytes: 0,
    };
    c.rows += i.rows;
    c.bytes += i.bytes;
    out.set(i.classId, c);
  }
  return [...out.values()];
}

// --- Archive --------------------------------------------------------------------------------------

/** One gzip file of JSON lines, `{class, table, row}`, written as the batches go. */
class ArchiveWriter {
  private gz: ReturnType<typeof createGzip> | null = null;
  private out: ReturnType<typeof createWriteStream> | null = null;
  constructor(
    readonly dir: string,
    readonly name: string,
  ) {}

  private open() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.out = createWriteStream(join(this.dir, this.name), { mode: 0o600 });
    this.gz = createGzip();
    this.gz.pipe(this.out);
  }

  /** Written and flushed when it returns: the batch can then be committed. */
  async write(classId: string, rows: { table: string; row: unknown }[]): Promise<void> {
    if (!rows.length) return;
    if (!this.gz) this.open();
    const text = rows
      .map((r) => JSON.stringify({ class: classId, table: r.table, row: r.row }))
      .join('\n');
    const gz = this.gz!;
    await new Promise<void>((resolve, reject) =>
      gz.write(`${text}\n`, (e) => (e ? reject(e) : resolve())),
    );
    await new Promise<void>((resolve) => gz.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()));
  }

  /** The name of the file, or null when nothing was written. */
  async close(): Promise<string | null> {
    if (!this.gz || !this.out) return null;
    this.gz.end();
    await once(this.out, 'finish');
    return this.name;
  }
}

// --- Purge ----------------------------------------------------------------------------------------

export interface PurgeClassResult {
  classId: string;
  label: string;
  cutoff: string;
  rows: number;
}

export interface PurgeSummary {
  trigger: 'manual' | 'nightly';
  startedAt: string;
  finishedAt: string;
  classes: PurgeClassResult[];
  total: number;
  /** Size of the database before and after (bytes). */
  bytesBefore: number;
  bytesAfter: number;
  archiveFile: string | null;
  /** The time limit was reached before everything was done: the rest goes at the next run. */
  truncated: boolean;
  error: string | null;
  /** Members anonymised by the same run (nightly). */
  anonymized?: number;
}

export interface PurgeOptions {
  /** Classes to purge (default: all those with a duration). */
  classIds?: string[];
  archive: boolean;
  archiveDir: string;
  trigger: 'manual' | 'nightly';
  batchSize?: number;
  /** Stops starting new batches after this time. */
  maxMs?: number;
  pauseMs?: number;
  /** Members anonymised by the same run: told in the summary. */
  anonymized?: number;
  /** Writes the journal entry, in the transaction that stores the size snapshot. */
  record: (tx: Tx, summary: PurgeSummary) => Promise<void>;
  onProgress?: (classId: string, rows: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const purgeState: {
  running: boolean;
  trigger: 'manual' | 'nightly' | null;
  startedAt: Date | null;
  current: string | null;
  rows: number;
  last: PurgeSummary | null;
} = { running: false, trigger: null, startedAt: null, current: null, rows: 0, last: null };

const stamp = (d: Date) => d.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
export const ARCHIVE_NAME = /^purge-\d{8}-\d{6}-(manual|nightly)\.jsonl\.gz$/;

/**
 * Purges, in batches of small transactions. One at a time (a second call is refused). The journal
 * entry is a summary written at the end: what, how many, which cutoff, never row by row.
 */
export async function runPurge(
  db: Db,
  settings: RetentionSettings,
  now: Date,
  opts: PurgeOptions,
): Promise<PurgeSummary> {
  if (purgeState.running) throw new Error('PURGE_RUNNING');
  purgeState.running = true;
  purgeState.trigger = opts.trigger;
  purgeState.startedAt = now;
  purgeState.rows = 0;
  purgeState.current = null;
  const batch = opts.batchSize ?? BATCH;
  const deadline = opts.maxMs ? Date.now() + opts.maxMs : Infinity;
  const writer = opts.archive
    ? new ArchiveWriter(opts.archiveDir, `purge-${stamp(now)}-${opts.trigger}.jsonl.gz`)
    : null;
  const results = new Map<string, PurgeClassResult>();
  let truncated = false;
  let error: string | null = null;
  const bytesBefore = await totalDatabaseBytes(db);
  try {
    const plan = (await buildPlan(db, settings, now, opts.classIds)).filter((p) => p.rows > 0);
    outer: for (const item of plan) {
      purgeState.current = item.label;
      const res = results.get(item.classId) ?? {
        classId: item.classId,
        label: item.label,
        cutoff: item.cutoff.toISOString(),
        rows: 0,
      };
      results.set(item.classId, res);
      for (;;) {
        if (Date.now() > deadline) {
          truncated = true;
          break outer;
        }
        // One transaction per batch: the archive is written before the batch is committed.
        const n = await db.transaction(async (tx) => {
          const r = await retentionRun(
            tx,
            item.kind,
            item.cutoff,
            batch,
            writer ? 'archive' : 'purge',
            item.keys,
          );
          if (writer && r.removed) await writer.write(item.classId, r.removed);
          return Number(r.n);
        });
        res.rows += n;
        purgeState.rows += n;
        opts.onProgress?.(item.classId, res.rows);
        if (n < batch) break;
        await sleep(opts.pauseMs ?? 25);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    const archiveFile = await writer?.close();
    const classes = [...results.values()].filter((c) => c.rows > 0);
    const summary: PurgeSummary = {
      trigger: opts.trigger,
      startedAt: now.toISOString(),
      finishedAt: new Date().toISOString(),
      classes,
      total: classes.reduce((a, c) => a + c.rows, 0),
      bytesBefore,
      bytesAfter: await totalDatabaseBytes(db),
      archiveFile: archiveFile ?? null,
      truncated,
      error,
      ...(opts.anonymized ? { anonymized: opts.anonymized } : {}),
    };
    if (summary.total > 0 || error) {
      await db.transaction(async (tx) => {
        await opts.record(tx, summary);
        await takeSizeSnapshot(tx, 'after_purge');
      });
    }
    purgeState.last = summary;
    return summary;
  } finally {
    purgeState.running = false;
    purgeState.current = null;
  }
}
