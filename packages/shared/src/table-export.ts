import { z } from 'zod';
import { hasAnyRole, type RoleCode } from './roles';

// « Exporter en Excel » on every list of the application. The browser sends what the list shows
// (filters and sort applied) and the server writes the file. Pure rules: who may export from which
// screen, and how the text of a cell becomes a number or a date.

/**
 * The screens an export can come from, and who may export from them. The roles are the ones that
 * open the screen (ADMIN opens all): exporting needs no more than seeing, and no less. A screen
 * about one's own data (the shop, one's household, one's own reports) is open to every signed-in
 * person. The longest prefix wins, so the most specific screen decides.
 */
export const EXPORT_SCOPES = [
  { key: 'caisse', prefix: '/caisse', roles: ['CAISSE'] },
  { key: 'membres', prefix: '/membres', roles: ['ADHERENTS'] },
  { key: 'foyers', prefix: '/foyers', roles: ['ADHERENTS'] },
  { key: 'catalogue', prefix: '/catalogue', roles: ['PRODUITS'] },
  { key: 'appros', prefix: '/appros', roles: ['APPROS'] },
  {
    key: 'precommandes',
    prefix: '/precommandes',
    roles: ['COMMANDES_EN_LIGNE', 'COMMANDES_GESTION'],
  },
  { key: 'compta', prefix: '/compta', roles: ['COMPTA'] },
  { key: 'stats', prefix: '/stats', roles: ['STATS'] },
  { key: 'admin', prefix: '/admin', roles: ['ADMIN'] },
  { key: 'surveillance', prefix: '/surveillance', roles: ['ADMIN', 'COMPTA'] },
  { key: 'imports', prefix: '/imports', roles: ['PRODUITS', 'ADHERENTS'] },
  { key: 'signalements-gestion', prefix: '/signalements/gestion', roles: ['ADMIN'] },
  // One's own data: any signed-in person.
  { key: 'perso', prefix: '/boutique', roles: [] },
  { key: 'perso', prefix: '/mon-foyer', roles: [] },
  { key: 'perso', prefix: '/signalements', roles: [] },
  { key: 'accueil', prefix: '/', roles: [] },
] as const satisfies readonly { key: string; prefix: string; roles: readonly RoleCode[] }[];

export type ExportScope = (typeof EXPORT_SCOPES)[number]['key'];
export const EXPORT_SCOPE_KEYS = [...new Set(EXPORT_SCOPES.map((s) => s.key))] as [
  ExportScope,
  ...ExportScope[],
];

/** Roles that may export from a screen: any of them (empty: every signed-in person). */
export function exportRolesOf(scope: ExportScope): readonly RoleCode[] {
  const roles = new Set<RoleCode>();
  let any = false;
  for (const s of EXPORT_SCOPES)
    if (s.key === scope) {
      if (s.roles.length === 0) any = true;
      for (const r of s.roles) roles.add(r);
    }
  return any ? [] : [...roles];
}

export function canExport(userRoles: readonly RoleCode[], scope: ExportScope): boolean {
  return hasAnyRole(userRoles, exportRolesOf(scope));
}

/** The export scope of the page a person is on: `/membres/foyers/3` → `membres`. */
export function exportScopeOfPath(pathname: string): ExportScope {
  const path = (pathname.split(/[?#]/)[0] ?? '').replace(/\/+$/, '') || '/';
  let best: { key: ExportScope; length: number } | null = null;
  for (const s of EXPORT_SCOPES) {
    const hit =
      s.prefix === '/' ? path === '/' : path === s.prefix || path.startsWith(`${s.prefix}/`);
    if (hit && (!best || s.prefix.length > best.length))
      best = { key: s.key, length: s.prefix.length };
  }
  // An unknown page is the strictest scope: only an administrator exports from it.
  return best?.key ?? 'admin';
}

// --- What an export holds -------------------------------------------------------------------

export const EXPORT_LIMITS = {
  columns: 60,
  rows: 20_000,
  cell: 2000,
  title: 100,
} as const;

export const EXPORT_COLUMN_TYPES = ['text', 'number', 'money', 'date', 'datetime'] as const;
export type ExportColumnType = (typeof EXPORT_COLUMN_TYPES)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const cell = z.union([z.string().max(EXPORT_LIMITS.cell), z.number().finite(), z.null()]);

export const tableExportSchema = z
  .object({
    scope: z.enum(EXPORT_SCOPE_KEYS),
    title: z.string().trim().min(1).max(EXPORT_LIMITS.title),
    columns: z
      .array(
        z.object({
          header: z.string().trim().max(200),
          type: z.enum(EXPORT_COLUMN_TYPES),
        }),
      )
      .min(1)
      .max(EXPORT_LIMITS.columns),
    rows: z.array(z.array(cell)).max(EXPORT_LIMITS.rows),
  })
  .superRefine((v, ctx) => {
    for (const [i, row] of v.rows.entries()) {
      if (row.length !== v.columns.length)
        return ctx.addIssue({
          code: 'custom',
          path: ['rows', i],
          message: 'Une ligne n’a pas autant de cellules que de colonnes.',
        });
      for (const [j, c] of row.entries()) {
        const type = v.columns[j]!.type;
        const ok =
          c === null ||
          (type === 'text' && typeof c === 'string') ||
          ((type === 'number' || type === 'money') && typeof c === 'number') ||
          (type === 'date' && typeof c === 'string' && DATE.test(c)) ||
          (type === 'datetime' && typeof c === 'string' && DATETIME.test(c));
        if (!ok)
          return ctx.addIssue({
            code: 'custom',
            path: ['rows', i, j],
            message: 'La valeur ne correspond pas au type de sa colonne.',
          });
      }
    }
  });
export type TableExport = z.infer<typeof tableExportSchema>;

/** A file name made of letters, digits, dashes: never a path, never a quote. */
export function exportFileName(title: string, day: string): string {
  const base = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'export'}-${day}.xlsx`;
}

// --- Reading the text of a cell ---------------------------------------------------------------

/** Spaces of every kind (no-break, narrow no-break) become a plain one. */
const plain = (s: string) => s.replace(/[\s\u00a0\u202f]+/g, ' ').trim();

const MONEY = /^-?\d{1,3}( ?\d{3})*(,\d{1,2})? ?€$|^-?\d+(,\d{1,2})? ?€$/;
const NUMBER = /^-?(0|[1-9]\d{0,14})(,\d+)?$/;
const NUMBER_SPACED = /^-?[1-9]\d{0,2}( \d{3})+(,\d+)?$/;
const DATE_FR = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const DATETIME_FR = /^(\d{2})\/(\d{2})\/(\d{4}),? (\d{2}):(\d{2})$/;
/** A column named like a code stays text: leading zeros and long numbers must survive. */
const CODE_HEADER =
  /\b(code|ean|n°|numéro|numero|téléphone|telephone|siret|iban|référence|reference|ref)\b/i;

export function parseFrenchNumber(text: string): number | null {
  const t = plain(text).replace(/ ?€$/, '').replace(/^−/, '-');
  const compact = NUMBER_SPACED.test(t) ? t.replace(/ /g, '') : t;
  if (!NUMBER.test(compact)) return null;
  const n = Number(compact.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const validDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** `14/11/2026` → `2026-11-14`; `14/11/2026 10:30` → `2026-11-14T10:30`; otherwise null. */
export function parseFrenchDate(text: string): { value: string; time: boolean } | null {
  const t = plain(text);
  const d = DATE_FR.exec(t);
  if (d && validDate(+d[3]!, +d[2]!, +d[1]!))
    return { value: `${d[3]}-${d[2]}-${d[1]}`, time: false };
  const dt = DATETIME_FR.exec(t);
  if (dt && validDate(+dt[3]!, +dt[2]!, +dt[1]!) && +dt[4]! < 24 && +dt[5]! < 60)
    return { value: `${dt[3]}-${dt[2]}-${dt[1]}T${dt[4]}:${dt[5]}`, time: true };
  return null;
}

/**
 * The type of each column and its cells, from the text the list shows: a column whose every filled
 * cell is an amount, a number or a date is exported as such (so Excel can add and sort it), any
 * other is text. One doubtful cell keeps the whole column as text: nothing is ever altered.
 */
export function typeColumns(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): { columns: TableExport['columns']; rows: TableExport['rows'] } {
  const columns: TableExport['columns'] = [];
  const kinds: ExportColumnType[] = [];
  for (const [j, header] of headers.entries()) {
    const values = rows.map((r) => plain(r[j] ?? '')).filter((v) => v !== '');
    let type: ExportColumnType = 'text';
    if (values.length > 0 && !CODE_HEADER.test(header)) {
      if (values.every((v) => MONEY.test(v) && parseFrenchNumber(v) !== null)) type = 'money';
      else if (values.every((v) => parseFrenchNumber(v) !== null)) type = 'number';
      else {
        const dates = values.map(parseFrenchDate);
        if (dates.every((d) => d !== null)) type = dates.some((d) => d!.time) ? 'datetime' : 'date';
      }
    }
    kinds.push(type);
    columns.push({ header: plain(header), type });
  }
  return {
    columns,
    rows: rows.map((r) =>
      kinds.map((type, j) => {
        const raw = plain(r[j] ?? '');
        if (raw === '') return null;
        if (type === 'money' || type === 'number') return parseFrenchNumber(raw);
        if (type === 'date' || type === 'datetime') {
          const d = parseFrenchDate(raw)!;
          // A column of dates with times: a cell with only the day gets midnight.
          return type === 'datetime' && !d.time ? `${d.value}T00:00` : d.value;
        }
        return raw.slice(0, EXPORT_LIMITS.cell);
      }),
    ),
  };
}
