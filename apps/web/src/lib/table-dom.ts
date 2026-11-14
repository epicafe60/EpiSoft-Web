// Reads a table of the screen as it is displayed (filters and sort applied): the headers and the
// text of every cell. Written against the few properties of the DOM it uses, so that it can be
// tested with plain objects.

export interface NodeLike {
  nodeType: number;
  nodeValue?: string | null;
  childNodes?: ArrayLike<NodeLike>;
  tagName?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  selectedOptions?: ArrayLike<{ textContent: string | null }>;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
}
export interface CellLike extends NodeLike {
  colSpan?: number;
}
export interface RowLike {
  cells: ArrayLike<CellLike>;
}
export interface TableLike {
  tHead?: { rows: ArrayLike<RowLike> } | null;
  tBodies: ArrayLike<{ rows: ArrayLike<RowLike> }>;
  rows?: ArrayLike<RowLike>;
}

const ELEMENT = 1;
const TEXT = 3;
const BLOCK = new Set(['DIV', 'P', 'LI', 'BR', 'TR', 'H1', 'H2', 'H3']);
/** Columns that only hold buttons, whatever their header says. */
const ACTION_HEADER = /^(actions?|détails?|voir|ouvrir|modifier|supprimer)$/i;

/** The text of a cell as a person reads it: a select says its chosen option, a box its value. */
export function cellText(node: NodeLike): string {
  if (node.nodeType === TEXT) return node.nodeValue ?? '';
  if (node.nodeType !== ELEMENT) return '';
  const tag = (node.tagName ?? '').toUpperCase();
  const cls = node.getAttribute?.('class') ?? '';
  // What is only for a screen reader or marked as not for the file is left out.
  if (node.hasAttribute?.('data-no-export') || /\bsr-only\b/.test(cls) || tag === 'SVG') return '';
  if (node.hasAttribute?.('hidden') || node.getAttribute?.('aria-hidden') === 'true') return '';
  if (tag === 'SELECT')
    return Array.from(node.selectedOptions ?? [])
      .map((o) => o.textContent ?? '')
      .join(', ');
  if (tag === 'INPUT') {
    if (node.type === 'checkbox' || node.type === 'radio') return node.checked ? 'Oui' : 'Non';
    return node.type === 'hidden' || node.type === 'search' ? '' : (node.value ?? '');
  }
  if (tag === 'TEXTAREA') return node.value ?? '';
  const inner = Array.from(node.childNodes ?? [])
    .map(cellText)
    .join('');
  return BLOCK.has(tag) ? ` ${inner} ` : inner;
}

const clean = (s: string) => s.replace(/[\s\u00a0\u202f]+/g, ' ').trim();

/** Headers and rows of the table; a column with no header, or only buttons, is left out. */
export function readTable(table: TableLike): { headers: string[]; rows: string[][] } {
  const headRow = table.tHead?.rows[0] ?? table.rows?.[0];
  if (!headRow) return { headers: [], rows: [] };
  const headers: string[] = [];
  for (const c of Array.from(headRow.cells)) {
    const text = clean(cellText(c));
    for (let i = 0; i < Math.max(1, c.colSpan ?? 1); i++) headers.push(text);
  }
  const keep = headers.map((h) => h !== '' && !ACTION_HEADER.test(h));
  const rows: string[][] = [];
  for (const body of Array.from(table.tBodies))
    for (const row of Array.from(body.rows)) {
      const cells = Array.from(row.cells);
      // « Chargement… », « Aucun résultat » : one cell across the whole table is not a record.
      if (cells.length === 1 && headers.length > 1) continue;
      const texts: string[] = [];
      for (const c of cells)
        for (let i = 0; i < Math.max(1, c.colSpan ?? 1); i++) texts.push(clean(cellText(c)));
      rows.push(headers.map((_, j) => texts[j] ?? '').filter((_, j) => keep[j]));
    }
  return { headers: headers.filter((_, j) => keep[j]), rows };
}
