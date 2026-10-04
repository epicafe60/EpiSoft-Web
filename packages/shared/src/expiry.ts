// R-STK-07 — best-before dates (DLC/DDM): pure helpers shared by the API and the UI.

export const EXPIRY_WARN_DAYS = 7;

export type ExpiryStatus = 'EXPIRED' | 'SOON' | 'OK';

const DAY_MS = 86_400_000;
const utcDay = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** Whole days from `today` to `bestBefore` (both YYYY-MM-DD); negative once past. */
export const daysUntil = (bestBefore: string, today: string): number =>
  Math.round((utcDay(bestBefore) - utcDay(today)) / DAY_MS);

/** EXPIRED once the date is strictly past (the last day is still sellable), SOON within `warnDays`. */
export function expiryStatus(
  bestBefore: string,
  today: string,
  warnDays = EXPIRY_WARN_DAYS,
): ExpiryStatus {
  const d = daysUntil(bestBefore, today);
  return d < 0 ? 'EXPIRED' : d <= warnDays ? 'SOON' : 'OK';
}
