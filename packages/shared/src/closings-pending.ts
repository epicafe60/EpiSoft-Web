// ADR 0016 §3: what is left to close (« Z »), and what can be closed now. The rules are those of the
// server (apps/api/src/modules/fiscal/periods.ts), written once here so that the screen shows exactly
// what the server will accept: a day is closed in order and when no drawer is open, a month when it
// is over and all its days with tickets are closed, a year when it is over and all its months are.

export type ClosingKind = 'DAY' | 'MONTH' | 'YEAR';

export interface PendingClosingsInput {
  /** The day of the shop (YYYY-MM-DD). */
  today: string;
  /** Accounting days with documents. */
  salesByDay: readonly { day: string; tickets: number }[];
  /** Start dates of the closings already made, by kind. */
  closed: { DAY: readonly string[]; MONTH: readonly string[]; YEAR: readonly string[] };
  /** Days (shop time) on which a cash session still open was opened. */
  openSessionDays: readonly string[];
}

export interface PendingClosing {
  kind: ClosingKind;
  /** First day of the period. */
  start: string;
  /** Last day of the period. */
  end: string;
  tickets: number;
  ready: boolean;
  /** What to do first, when it is not ready. */
  reason: string | null;
}

const frDay = (d: string) => d.split('-').reverse().join('/');
const monthLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

export function periodEndOf(kind: ClosingKind, start: string): string {
  const [y, m] = start.split('-').map(Number) as [number, number];
  if (kind === 'DAY') return start;
  const last = kind === 'MONTH' ? new Date(Date.UTC(y, m, 0)) : new Date(Date.UTC(y, 12, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * The closings to make, oldest first: the days, then the months, then the years. Only the oldest day
 * can be closed (the days are closed in order, a later day closed first would lock the earlier one).
 */
export function pendingClosings(input: PendingClosingsInput): PendingClosing[] {
  const closedDays = new Set(input.closed.DAY);
  const closedMonths = new Set(input.closed.MONTH);
  const closedYears = new Set(input.closed.YEAR);
  const days = [...input.salesByDay].sort((a, b) => a.day.localeCompare(b.day));
  const out: PendingClosing[] = [];

  // --- Days
  const lastClosedDay = [...closedDays].sort().at(-1) ?? '';
  let first = true;
  for (const d of days) {
    if (closedDays.has(d.day)) continue;
    let reason: string | null = null;
    if (d.day > input.today) reason = 'Une journée à venir ne se clôture pas.';
    else if (d.day < lastClosedDay)
      reason = `Le ${frDay(lastClosedDay)} est déjà clôturé : cette journée ne peut plus l’être (contrôle d’intégrité).`;
    else if (input.openSessionDays.some((s) => s <= d.day))
      reason = 'Une session de caisse est encore ouverte : clôturez la caisse d’abord.';
    else if (!first) reason = 'Clôturez d’abord la journée précédente (dans l’ordre).';
    first = false;
    out.push({
      kind: 'DAY',
      start: d.day,
      end: d.day,
      tickets: d.tickets,
      ready: reason === null,
      reason,
    });
  }

  // --- Months and years over, with documents, not closed yet
  const monthsWithDays = new Map<string, { days: string[]; tickets: number }>();
  for (const d of days) {
    const m = `${d.day.slice(0, 7)}-01`;
    const e = monthsWithDays.get(m) ?? { days: [], tickets: 0 };
    e.days.push(d.day);
    e.tickets += d.tickets;
    monthsWithDays.set(m, e);
  }
  for (const [m, e] of [...monthsWithDays].sort(([a], [b]) => a.localeCompare(b))) {
    const end = periodEndOf('MONTH', m);
    if (closedMonths.has(m) || end >= input.today) continue;
    const missing = e.days.filter((x) => !closedDays.has(x));
    out.push({
      kind: 'MONTH',
      start: m,
      end,
      tickets: e.tickets,
      ready: missing.length === 0,
      reason: missing.length
        ? `Clôturez d’abord les journées : ${missing.map(frDay).join(', ')}.`
        : null,
    });
  }
  const years = new Map<string, { months: Set<string>; tickets: number }>();
  for (const [m, e] of monthsWithDays) {
    const y = `${m.slice(0, 4)}-01-01`;
    const entry = years.get(y) ?? { months: new Set<string>(), tickets: 0 };
    entry.months.add(m);
    entry.tickets += e.tickets;
    years.set(y, entry);
  }
  for (const [y, e] of [...years].sort(([a], [b]) => a.localeCompare(b))) {
    const end = periodEndOf('YEAR', y);
    if (closedYears.has(y) || end >= input.today) continue;
    const missing = [...e.months].filter((x) => !closedMonths.has(x)).sort();
    out.push({
      kind: 'YEAR',
      start: y,
      end,
      tickets: e.tickets,
      ready: missing.length === 0,
      reason: missing.length
        ? `Clôturez d’abord les mois : ${missing.map(monthLabel).join(', ')}.`
        : null,
    });
  }
  return out;
}

export const CLOSING_KIND_LABELS: Record<ClosingKind, string> = {
  DAY: 'Journée',
  MONTH: 'Mois',
  YEAR: 'Année',
};
