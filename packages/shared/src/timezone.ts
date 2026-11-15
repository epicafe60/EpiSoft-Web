// The time zone of the shop: the calendar day of a ticket, of a closing, of a statistic. It is a
// setting (Administration › Paramètres); the Épicafé's is Europe/Paris. One value for the whole
// process: the server reads it at start and when it is saved, the browser reads it with the identity
// of the application.

export const DEFAULT_TIME_ZONE = 'Europe/Paris';

export function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let current = DEFAULT_TIME_ZONE;

/** The time zone of the shop. */
export const appTimeZone = (): string => current;

/** Changes it; an unknown name is ignored (the previous one stays). */
export function setAppTimeZone(tz: string): void {
  if (isValidTimeZone(tz)) current = tz;
}

/** The name as an SQL text literal (`'Europe/Paris'`): the name is checked, so nothing can be injected. */
export function timeZoneLiteral(): string {
  if (!isValidTimeZone(current)) throw new Error('Fuseau horaire invalide.');
  return `'${current}'`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** A formatter in the time zone of the shop (kept: building one is slow). */
export function shopFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${current}|${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: current });
    formatters.set(key, f);
  }
  return f;
}
