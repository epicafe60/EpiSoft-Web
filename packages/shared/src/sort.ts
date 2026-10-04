// Column sorting for the tables of the UI (§5.1). Pure, so it is tested.
import { normalizeSearch } from './text';

export type SortValue = string | number | null | undefined;
export type SortDir = 'asc' | 'desc';

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** Empty values always go last, whatever the direction; text is compared the French way. */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const r =
    typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return dir === 'asc' ? r : -r;
}

export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((x, y) => compareValues(x.v, y.v, dir) || x.i - y.i)
    .map((x) => x.row);
}

// --- Column filters (the search box under a table header) -------------------------------------

/**
 * Does a cell match what was typed in its column filter?
 * - empty query: always;
 * - numeric cell: ">10", ">=10", "<5", "<=5", "=7" (comma or dot decimals), or a plain number
 *   that must appear in the value;
 * - otherwise: case- and accent-insensitive "contains".
 */
export function matchesColumnFilter(value: SortValue, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (typeof value === 'number') {
    const op = /^(>=|<=|>|<|=)\s*(-?\d+(?:[.,]\d+)?)$/.exec(q);
    if (op) {
      const n = Number(op[2]!.replace(',', '.'));
      switch (op[1]) {
        case '>':
          return value > n;
        case '>=':
          return value >= n;
        case '<':
          return value < n;
        case '<=':
          return value <= n;
        default:
          return value === n;
      }
    }
    return String(value).includes(q.replace(',', '.'));
  }
  if (value === null || value === undefined) return false;
  const text = String(value);
  // ISO dates are shown as dd/mm/yyyy: both spellings can be typed.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const haystack = iso ? `${text} ${iso[3]}/${iso[2]}/${iso[1]}` : text;
  return normalizeSearch(haystack).includes(normalizeSearch(q));
}

/** Keeps the rows matching every non-empty column filter (AND). */
export function filterRows<T>(
  rows: readonly T[],
  accessors: Record<string, (row: T) => SortValue>,
  filters: Record<string, string>,
): T[] {
  const active = Object.entries(filters).filter(([k, v]) => v.trim() && accessors[k]);
  if (!active.length) return [...rows];
  return rows.filter((row) => active.every(([k, v]) => matchesColumnFilter(accessors[k]!(row), v)));
}
