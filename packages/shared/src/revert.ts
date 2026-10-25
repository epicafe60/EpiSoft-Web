// R-ADM-06: undoing an action from the journal by putting back the values it changed. The rows an
// action touched are known exactly (data_change, one entry per row and per change, written by a
// database trigger); this decides what to write back, and refuses when that would erase a change
// made since (the administrator then undoes the more recent action first).

export type ChangeOp = 'I' | 'U' | 'D';

/** One row of data_change: for U, `old` and `new` hold only the columns that changed. */
export interface RowChange {
  id: number;
  table: string;
  key: Record<string, unknown> | null;
  op: ChangeOp;
  old: Record<string, unknown> | null;
  new: Record<string, unknown> | null;
}

export type RestoreStep =
  | { table: string; key: Record<string, unknown>; kind: 'update'; set: Record<string, unknown> }
  | { table: string; key: Record<string, unknown>; kind: 'delete' }
  | { table: string; key: Record<string, unknown>; kind: 'insert'; row: Record<string, unknown> };

export type ConflictKind =
  /** Changed since: the columns hold something else than what the action left. */
  | 'changed'
  /** The row was deleted since. */
  | 'deleted'
  /** A row with the same key exists again. */
  | 'exists'
  /** The value to put back was not recorded (a secret or a file). */
  | 'secret'
  /** The table has no primary key: the row cannot be found again. */
  | 'nokey';

export interface RestoreConflict {
  table: string;
  key: Record<string, unknown> | null;
  kind: ConflictKind;
  columns?: string[];
}

export interface RestorePlan {
  steps: RestoreStep[];
  conflicts: RestoreConflict[];
}

/**
 * Bookkeeping columns: the time of the last change moves at every change, so it is neither a
 * conflict nor something to put back (the undo is a change: it sets it to now).
 */
const BOOKKEEPING = new Set(['updated_at']);

/** The key of a row, to look up its current state. */
export const rowId = (table: string, key: Record<string, unknown> | null) =>
  `${table}:${JSON.stringify(key)}`;

/** What the capture writes instead of a secret ("***") or of a file ({"octets": n}). */
export function isRedacted(v: unknown): boolean {
  return (
    v === '***' ||
    (typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      Object.keys(v).length === 1 &&
      'octets' in v)
  );
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?|Z)$/;

/**
 * Same value, as read from two JSON snapshots of the database. A timestamp may be written with
 * another time zone offset depending on the session: compared as an instant.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a === 'string' &&
    typeof b === 'string' &&
    ISO_TIMESTAMP.test(a) &&
    ISO_TIMESTAMP.test(b)
  )
    return new Date(a).getTime() === new Date(b).getTime() && fraction(a) === fraction(b);
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null)
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  return false;
}

/** Microseconds beyond the milliseconds a Date keeps. */
function fraction(ts: string): string {
  return (/\.(\d+)/.exec(ts)?.[1] ?? '').padEnd(6, '0').slice(3, 6);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/**
 * The writes that put the rows back as they were before the action, given their current state
 * (`current(rowId)`: the whole row as JSON, or null when it no longer exists).
 * Several changes of the same row in the action are taken together. Steps are ordered from the
 * last row touched to the first, so that foreign keys hold (children before parents).
 */
export function planRestore(
  changes: RowChange[],
  current: (id: string) => Record<string, unknown> | null,
): RestorePlan {
  interface Net {
    table: string;
    key: Record<string, unknown> | null;
    existedBefore: boolean;
    existsAfter: boolean;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    last: number;
  }
  const rows = new Map<string, Net>();
  for (const c of [...changes].sort((a, b) => a.id - b.id)) {
    const id = rowId(c.table, c.key);
    let n = rows.get(id);
    if (!n) {
      n = {
        table: c.table,
        key: c.key,
        existedBefore: c.op !== 'I',
        existsAfter: true,
        before: {},
        after: {},
        last: c.id,
      };
      rows.set(id, n);
    }
    // The earliest value of a column is the one to put back; the latest is the one to expect.
    for (const [k, v] of Object.entries(c.old ?? {})) if (!(k in n.before)) n.before[k] = v;
    if (c.op === 'D') n.after = {};
    else Object.assign(n.after, c.new ?? {});
    n.existsAfter = c.op !== 'D';
    n.last = c.id;
  }

  const steps: (RestoreStep & { last: number })[] = [];
  const conflicts: RestoreConflict[] = [];
  for (const [id, n] of rows) {
    if (!n.existedBefore && !n.existsAfter) continue;
    if (!n.key) {
      conflicts.push({ table: n.table, key: null, kind: 'nokey' });
      continue;
    }
    const now = current(id);
    const differs = (cols: string[]) =>
      cols.filter(
        (k) =>
          now && !BOOKKEEPING.has(k) && !isRedacted(n.after[k]) && !sameValue(now[k], n.after[k]),
      );

    if (n.existedBefore && n.existsAfter) {
      const cols = Object.keys(n.before).filter((k) => !sameValue(n.before[k], n.after[k]));
      if (!cols.some((k) => !BOOKKEEPING.has(k))) continue;
      if (!now) {
        conflicts.push({ table: n.table, key: n.key, kind: 'deleted' });
        continue;
      }
      const secret = cols.filter((k) => isRedacted(n.before[k]));
      if (secret.length) {
        conflicts.push({ table: n.table, key: n.key, kind: 'secret', columns: secret });
        continue;
      }
      const changed = differs(cols);
      if (changed.length) {
        conflicts.push({ table: n.table, key: n.key, kind: 'changed', columns: changed });
        continue;
      }
      steps.push({
        table: n.table,
        key: n.key,
        kind: 'update',
        set: Object.fromEntries(cols.map((k) => [k, n.before[k]])),
        last: n.last,
      });
    } else if (!n.existedBefore) {
      // Created by the action: deleted, unless it was changed since.
      if (!now) continue;
      const changed = differs(Object.keys(n.after));
      if (changed.length) {
        conflicts.push({ table: n.table, key: n.key, kind: 'changed', columns: changed });
        continue;
      }
      steps.push({ table: n.table, key: n.key, kind: 'delete', last: n.last });
    } else {
      // Deleted by the action: created again with its recorded values.
      if (now) {
        conflicts.push({ table: n.table, key: n.key, kind: 'exists' });
        continue;
      }
      const secret = Object.keys(n.before).filter((k) => isRedacted(n.before[k]));
      if (secret.length) {
        conflicts.push({ table: n.table, key: n.key, kind: 'secret', columns: secret });
        continue;
      }
      steps.push({ table: n.table, key: n.key, kind: 'insert', row: n.before, last: n.last });
    }
  }
  return {
    steps: steps.sort((a, b) => b.last - a.last).map(({ last: _last, ...s }) => s as RestoreStep),
    conflicts,
  };
}

/** What « Annuler cette action » announces before it is confirmed (GET /admin/audit/:id/revert). */
export interface RevertPreview {
  entry: { id: string; at: string; actorName: string | null; sentence: string };
  /** Other actions of the same transaction, undone together. */
  siblings: { id: string; sentence: string }[];
  revertedBy: { id: string; at: string; actorName: string | null } | null;
  kind: 'restore' | 'compensate' | 'via' | 'none';
  /** The confirmation can be given. */
  possible: boolean;
  /** What the button does. */
  label: string | null;
  /** Why it cannot be done here (via, none, or a refusal). */
  reason: string | null;
  /** The screen where it is done (via). */
  link: string | null;
  /** What the undo will do, in words. */
  message: string | null;
  /** The values put back: for each row, the values of the action and those of before. */
  steps: {
    table: string;
    kind: RestoreStep['kind'];
    values: Record<string, unknown> | null;
    current: Record<string, unknown> | null;
  }[];
  conflicts: {
    table: string;
    kind: ConflictKind;
    columns: string[];
    by: {
      auditId: string | null;
      at: string;
      actorName: string | null;
      sentence: string | null;
    } | null;
  }[];
}

/** The names of the tables, for the people who read the details of an action. */
export const TABLE_LABELS: Record<string, string> = {
  member: 'Fiche adhérent',
  household: 'Foyer',
  user_role: 'Rôle',
  setting: 'Réglage',
  product: 'Produit',
  product_barcode: 'Code-barres',
  price_history: 'Historique des prix',
  category: 'Rayon',
  universe: 'Univers',
  supplier: 'Fournisseur',
  stock_movement: 'Mouvement de stock',
  product_batch: 'Date limite',
  membership_type: 'Type d’adhésion',
  membership: 'Adhésion',
  member_payment: 'Versement',
  wallet_entry: 'Opération de cagnotte',
  pos_device: 'Poste de caisse',
  cash_session: 'Session de caisse',
  cash_count: 'Comptage de caisse',
  sale: 'Ticket',
  sale_line: 'Ligne de ticket',
  sale_payment: 'Paiement de ticket',
  purchase_order: 'Commande fournisseur',
  purchase_order_line: 'Ligne de commande',
  goods_receipt: 'Réception',
  goods_receipt_line: 'Ligne de réception',
  supplier_invoice: 'Facture fournisseur',
  inventory_session: 'Inventaire',
  inventory_line: 'Comptage d’inventaire',
  fiscal_year: 'Exercice comptable',
  account: 'Compte comptable',
  journal: 'Journal comptable',
  entry: 'Écriture comptable',
  entry_line: 'Ligne d’écriture',
  entry_template: 'Guide de saisie',
  bank_account: 'Compte bancaire',
  bank_statement: 'Relevé bancaire',
  bank_line: 'Ligne bancaire',
  bank_rule: 'Règle bancaire',
  cash_deposit: 'Remise en banque',
  preorder: 'Précommande',
  preorder_line: 'Ligne de précommande',
  product_review: 'Avis client',
  product_favorite: 'Favori',
  push_subscription: 'Notifications d’un appareil',
  integrity_ack: 'Point de contrôle accepté',
  email_outbox: 'Courriel',
  saved_report: 'Rapport enregistré',
  budget_line: 'Ligne de budget',
  media: 'Image',
};

export const tableLabel = (table: string) => TABLE_LABELS[table] ?? table;

/**
 * The order the writes must follow for the foreign keys to hold, whatever the order the rows were
 * recorded in: rows created again parents first, then the updates, then rows removed children
 * first. `parents` gives, for each table, the tables it points to.
 */
export function orderSteps(
  steps: RestoreStep[],
  parents: (table: string) => string[],
): RestoreStep[] {
  const depth = new Map<string, number>();
  const depthOf = (table: string, seen: Set<string> = new Set()): number => {
    const known = depth.get(table);
    if (known !== undefined) return known;
    if (seen.has(table)) return 0; // a cycle: cut it
    seen.add(table);
    const up = parents(table).filter((p) => p !== table);
    const d = up.length ? 1 + Math.max(...up.map((p) => depthOf(p, seen))) : 0;
    depth.set(table, d);
    return d;
  };
  // Array.prototype.sort is stable: within a table, the order of the plan is kept.
  const of = (kind: RestoreStep['kind']) => steps.filter((s) => s.kind === kind);
  return [
    ...of('insert').sort((a, b) => depthOf(a.table) - depthOf(b.table)),
    ...of('update'),
    ...of('delete').sort((a, b) => depthOf(b.table) - depthOf(a.table)),
  ];
}
