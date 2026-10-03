// Column sorting for the tables of the UI (§5.1). Pure, so it is tested.

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
