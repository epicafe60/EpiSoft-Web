import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { shopFormat, timeZoneLiteral } from '@episoft/shared';

// Business dates are the shop's dates (its time zone, a setting), whatever the server time zone.

/** YYYY-MM-DD in the time zone of the shop. */
export function toShopDate(d: Date): string {
  return shopFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function shopYear(d: Date): number {
  return Number(toShopDate(d).slice(0, 4));
}

/** "03/10/2026 18:42" for e-mails and reports. */
export function formatShop(d: Date): string {
  return shopFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

/**
 * The time zone as a piece of SQL (`at time zone 'Europe/Paris'`): a checked name, never a typed value.
 * Read when the query is built, not when the file is loaded: a change of the setting applies at once,
 * also to the queries written once at the top of a file.
 */
export const tzSql = (): SQLWrapper => ({ getSQL: (): SQL => sql.raw(timeZoneLiteral()) });
