// Audit journal: a GitHub-like comparison of the "before" and "after" payloads of an entry.

export type DiffKind = 'added' | 'removed' | 'changed' | 'same';

export interface DiffRow {
  /** Dotted path of the field, e.g. "address.city" or "roles[1]". */
  path: string;
  kind: DiffKind;
  before?: string;
  after?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaf values of a JSON document, by path; empty containers are leaves too. */
export function flattenJson(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string) => {
    if (isObject(v) && Object.keys(v).length) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    } else if (Array.isArray(v) && v.length) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else {
      out.set(path, v === undefined ? 'null' : JSON.stringify(v));
    }
  };
  walk(value, prefix);
  return out;
}

/**
 * Field-by-field comparison. A missing "before" makes every field added (creation), a missing
 * "after" makes every field removed (deletion). Rows follow the order of the "after" document,
 * then the fields that only existed before.
 */
export function diffJson(before: unknown, after: unknown): DiffRow[] {
  const a = before == null ? new Map<string, string>() : flattenJson(before);
  const b = after == null ? new Map<string, string>() : flattenJson(after);
  const rows: DiffRow[] = [];
  for (const [path, nv] of b) {
    if (!a.has(path)) rows.push({ path, kind: 'added', after: nv });
    else if (a.get(path) !== nv)
      rows.push({ path, kind: 'changed', before: a.get(path), after: nv });
    else rows.push({ path, kind: 'same', before: nv, after: nv });
  }
  for (const [path, ov] of a) if (!b.has(path)) rows.push({ path, kind: 'removed', before: ov });
  return rows;
}

/** The part of two strings that differs: common prefix and suffix are kept apart. */
export function inlineDiff(
  a: string,
  b: string,
): { prefix: string; oldMid: string; newMid: string; suffix: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return {
    prefix: a.slice(0, p),
    oldMid: a.slice(p, a.length - s),
    newMid: b.slice(p, b.length - s),
    suffix: a.slice(a.length - s),
  };
}
