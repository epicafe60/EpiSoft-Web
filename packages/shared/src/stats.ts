// Dashboard and statistics calculations (spec §4.12, R-STA-02/03). Pure functions.

export const PERIOD_KEYS = ['day', 'week', 'month', 'year'] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

/** Inclusive date range, ISO `YYYY-MM-DD`. */
export interface DateRange {
  from: string;
  to: string;
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};

/** Same calendar day one year earlier (29 Feb falls back to 28 Feb). */
export function sameDayLastYear(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y - 1, m - 1, d));
  if (last.getUTCMonth() !== m - 1) return toIso(new Date(Date.UTC(y - 1, m, 0)));
  return toIso(last);
}

/**
 * The period "to date" ending on `today` (R-STA-02): the day, the week from Monday, the month and
 * the year so far; and the same stretch one year earlier (N−1) for comparison.
 */
export function periodRange(
  key: PeriodKey,
  today: string,
): { current: DateRange; previous: DateRange } {
  let from = today;
  if (key === 'week') {
    const dow = (toDate(today).getUTCDay() + 6) % 7; // Monday = 0
    from = addDays(today, -dow);
  } else if (key === 'month') from = `${today.slice(0, 7)}-01`;
  else if (key === 'year') from = `${today.slice(0, 4)}-01-01`;
  return {
    current: { from, to: today },
    previous: { from: sameDayLastYear(from), to: sameDayLastYear(today) },
  };
}

/** Relative change in percent, `null` when there is nothing to compare with. */
export function variationPercent(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Average basket in cents; 0 without tickets. */
export function averageBasketCents(totalCents: number, tickets: number): number {
  return tickets > 0 ? Math.round(totalCents / tickets) : 0;
}

export function grossMargin(
  revenueCents: number,
  costCents: number,
): { marginCents: number; ratePercent: number | null } {
  const marginCents = revenueCents - costCents;
  return {
    marginCents,
    ratePercent: revenueCents ? Math.round((marginCents / revenueCents) * 1000) / 10 : null,
  };
}

/** Membership ending within `days` days (inclusive), not already over. */
export function expiresWithin(endDate: string, today: string, days: number): boolean {
  return endDate >= today && endDate <= addDays(today, days);
}

/**
 * Suggested order quantity, in thousandths of the unit: enough to cover `targetDays`
 * of sales at the observed rate and to get back above the minimum stock, net of the
 * current stock (a negative stock counts as zero) and of what is already on order.
 * Never negative; rounded up so the target is reached.
 */
export function suggestOrderQtyMilli(input: {
  stockMilli: number;
  soldMilli: number;
  periodDays: number;
  targetDays: number;
  minStockMilli: number;
  onOrderMilli: number;
}): number {
  const days = Math.max(1, input.periodDays);
  const needed = (input.soldMilli / days) * input.targetDays + Math.max(0, input.minStockMilli);
  const have = Math.max(0, input.stockMilli) + Math.max(0, input.onOrderMilli);
  return Math.max(0, Math.ceil(needed - have - 1e-9));
}
