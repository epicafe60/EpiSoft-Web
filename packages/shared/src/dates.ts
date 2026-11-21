import { z } from 'zod';
import { shopFormat } from './timezone';

// One date schema for every form (calendar day `YYYY-MM-DD`). A regex alone lets `2026-02-30` through
// and the database then answers with a 500: here the day must exist in the calendar and be plausible.

export const MIN_PLAUSIBLE_YEAR = 2000;
export const MAX_PLAUSIBLE_YEAR = 2100;

/** True when `s` is a real calendar day (`2026-02-30` and `2026-13-45` are not). */
export function isRealCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= last;
}

/** Today in the shop's time zone, `YYYY-MM-DD`. */
export function shopToday(now: Date = new Date()): string {
  return shopFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The first problem of a typed day (a single message: no pile of refusals on one field). */
function dateProblem(s: string): string | null {
  if (!isRealCalendarDate(s)) return 'Date invalide.';
  const y = Number(s.slice(0, 4));
  if (y < MIN_PLAUSIBLE_YEAR || y > MAX_PLAUSIBLE_YEAR)
    return `Date invraisemblable (entre ${MIN_PLAUSIBLE_YEAR} et ${MAX_PLAUSIBLE_YEAR}).`;
  return null;
}

const dateOf = (notInFuture: boolean) =>
  z.string().superRefine((s, ctx) => {
    const problem =
      dateProblem(s) ??
      (notInFuture && s > shopToday() ? 'La date ne peut pas être dans le futur.' : null);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/** A calendar day that exists, between 2000 and 2100. */
export const isoDate = dateOf(false);

/** A day that has happened: not after today (invoice, payment, receipt, top-up, membership…). */
export const pastOrTodayDate = dateOf(true);
