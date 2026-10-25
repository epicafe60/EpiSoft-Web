import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@episoft/db';
import {
  orderSteps,
  planRestore,
  rowId,
  type RestoreConflict,
  type RestorePlan,
  type RestoreStep,
  type RowChange,
} from '@episoft/shared';

// R-ADM-06: the generic « put back the previous values » of an action, from the rows its
// transaction changed (data_change). Table and column names come from the database catalogue and
// are written with sql.identifier; every value is a parameter.

/**
 * History: rows that record what happened (sales, movements, payments, cash counts). Putting the
 * previous values back would erase it, so an action that wrote them is undone by a
 * counter-operation, never by this.
 */
export const HISTORY_TABLES = new Set([
  'sale',
  'sale_line',
  'sale_payment',
  'stock_movement',
  'wallet_entry',
  'member_payment',
  'membership',
  'cash_session',
  'cash_count',
  'cash_deposit',
]);

/**
 * Left as they are by an undo: what was sent stays sent, a number given stays given, the price
 * history keeps every line.
 */
export const KEPT_TABLES = new Set([
  'email_outbox',
  'number_counter',
  'price_history',
  'sync_receipt',
  'wallet_snapshot',
  'wallet_low_notice',
  'membership_reminder',
]);

export interface LaterChange {
  at: string;
  auditId: string | null;
  action: string | null;
  actorName: string | null;
}

export interface PreparedRestore {
  changes: RowChange[];
  plan: RestorePlan;
  /** History tables the action wrote: the generic undo is refused. */
  historyTables: string[];
  /** For each conflict, the more recent action that changed the row (when known). */
  conflictsBy: (RestoreConflict & { by: LaterChange | null })[];
}

export async function loadChanges(db: DbOrTx, xact: string): Promise<RowChange[]> {
  const { rows } = await db.execute<{
    id: string;
    table_name: string;
    row_key: Record<string, unknown> | null;
    op: 'I' | 'U' | 'D';
    old: Record<string, unknown> | null;
    new: Record<string, unknown> | null;
  }>(sql`select id, table_name, row_key, op, old, new from app.data_change
         where xact = ${xact}::xid8 order by id`);
  return rows.map((r) => ({
    id: Number(r.id),
    table: r.table_name,
    key: r.row_key,
    op: r.op,
    old: r.old,
    new: r.new,
  }));
}

/** Columns of each table of the schema: the only names a statement below may contain. */
async function catalogue(db: DbOrTx): Promise<Map<string, Set<string>>> {
  const { rows } = await db.execute<{ table_name: string; column_name: string }>(
    sql`select table_name, column_name from information_schema.columns where table_schema = 'app'`,
  );
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!m.has(r.table_name)) m.set(r.table_name, new Set());
    m.get(r.table_name)!.add(r.column_name);
  }
  return m;
}

function checked(cat: Map<string, Set<string>>, table: string, columns: string[]) {
  const cols = cat.get(table);
  if (!cols) throw new Error(`Table inconnue : ${table}`);
  for (const c of columns) if (!cols.has(c)) throw new Error(`Colonne inconnue : ${table}.${c}`);
}

/** For each table of the schema, the tables its foreign keys point to. */
async function foreignKeys(db: DbOrTx): Promise<Map<string, string[]>> {
  const { rows } = await db.execute<{ child: string; parent: string }>(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c join pg_namespace ns on ns.oid = c.connamespace
    where c.contype = 'f' and ns.nspname = 'app'`);
  const m = new Map<string, string[]>();
  // regclass prints "app.table" (the schema is not on the search path): keep the table name.
  const bare = (t: string) => t.replace(/^app\./, '').replace(/"/g, '');
  for (const r of rows) {
    const child = bare(r.child);
    m.set(child, [...(m.get(child) ?? []), bare(r.parent)]);
  }
  return m;
}

const tableRef = (table: string) => sql`${sql.identifier('app')}.${sql.identifier(table)}`;

const keyWhere = (key: Record<string, unknown>): SQL =>
  sql.join(
    Object.entries(key).map(([c, v]) => sql`${sql.identifier(c)}::text = ${String(v)}`),
    sql` and `,
  );

async function currentRow(
  db: DbOrTx,
  table: string,
  key: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.execute<{ row: Record<string, unknown> }>(
    sql`select to_jsonb(t) as row from ${tableRef(table)} t where ${keyWhere(key)}`,
  );
  return rows[0]?.row ?? null;
}

/** The plan to put the rows of the transaction back, with what would prevent it. */
export async function prepareRestore(db: DbOrTx, xact: string): Promise<PreparedRestore> {
  const cat = await catalogue(db);
  const all = await loadChanges(db, xact);
  const changes = all.filter((c) => !KEPT_TABLES.has(c.table));
  const current = new Map<string, Record<string, unknown> | null>();
  for (const c of changes) {
    if (!c.key) continue;
    const id = rowId(c.table, c.key);
    if (current.has(id)) continue;
    checked(cat, c.table, Object.keys(c.key));
    current.set(id, await currentRow(db, c.table, c.key));
  }
  const planned = planRestore(changes, (id) => current.get(id) ?? null);
  const parents = await foreignKeys(db);
  const plan = { ...planned, steps: orderSteps(planned.steps, (t) => parents.get(t) ?? []) };
  const historyTables = [...new Set(changes.map((c) => c.table))].filter((t) =>
    HISTORY_TABLES.has(t),
  );
  const lastId = Math.max(0, ...all.map((c) => c.id));
  const conflictsBy = [];
  for (const conflict of plan.conflicts)
    conflictsBy.push({ ...conflict, by: await laterChange(db, conflict, lastId) });
  return { changes, plan, historyTables, conflictsBy };
}

/** The most recent action that changed the row after the one being undone. */
async function laterChange(
  db: DbOrTx,
  c: RestoreConflict,
  after: number,
): Promise<LaterChange | null> {
  if (!c.key) return null;
  const { rows } = await db.execute<{
    at: Date;
    audit_id: string | null;
    action: string | null;
    actor_name: string | null;
  }>(sql`
    select d.at, a.id as audit_id, a.action, m.first_name || ' ' || m.last_name as actor_name
    from app.data_change d
    left join lateral (select * from app.audit_log a where a.xact = d.xact order by a.id limit 1) a on true
    left join app.member m on m.id = a.actor_id
    where d.table_name = ${c.table} and d.row_key = ${JSON.stringify(c.key)}::jsonb and d.id > ${after}
    order by d.id desc limit 1`);
  const r = rows[0];
  return r
    ? {
        at: new Date(r.at).toISOString(),
        auditId: r.audit_id,
        action: r.action,
        actorName: r.actor_name,
      }
    : null;
}

/**
 * Writes the plan, in the order prepareRestore() gave it. A refusal of the database (a row used
 * elsewhere since…) is thrown as is.
 */
export async function applyRestore(db: DbOrTx, steps: RestoreStep[]): Promise<void> {
  const cat = await catalogue(db);
  for (const s of steps) {
    checked(cat, s.table, Object.keys(s.key));
    if (s.kind === 'delete') {
      await db.execute(sql`delete from ${tableRef(s.table)} where ${keyWhere(s.key)}`);
    } else if (s.kind === 'insert') {
      const cols = Object.keys(s.row).filter((c) => cat.get(s.table)!.has(c));
      checked(cat, s.table, cols);
      const list = sql.join(
        cols.map((c) => sql.identifier(c)),
        sql`, `,
      );
      await db.execute(sql`insert into ${tableRef(s.table)} (${list})
        select ${list} from jsonb_populate_record(null::${tableRef(s.table)}, ${JSON.stringify(s.row)}::jsonb)`);
    } else {
      const cols = Object.keys(s.set);
      checked(cat, s.table, cols);
      // The previous values, except the time of the last change: the row is changed now.
      const values = sql.join(
        cols.map((c) => (c === 'updated_at' ? sql`now()` : sql`r.${sql.identifier(c)}`)),
        sql`, `,
      );
      const list = sql.join(
        cols.map((c) => sql.identifier(c)),
        sql`, `,
      );
      await db.execute(sql`update ${tableRef(s.table)} set (${list}) = (
          select ${values} from jsonb_populate_record(null::${tableRef(s.table)}, ${JSON.stringify(s.set)}::jsonb) r)
        where ${keyWhere(s.key)}`);
    }
  }
}
