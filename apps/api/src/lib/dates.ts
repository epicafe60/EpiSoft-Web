// Business dates are Paris dates (the shop's), whatever the server time zone.

const parisDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in Europe/Paris. */
export function toParisDate(d: Date): string {
  return parisDate.format(d);
}

export function parisYear(d: Date): number {
  return Number(toParisDate(d).slice(0, 4));
}

const display = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  dateStyle: 'short',
  timeStyle: 'short',
});

/** "03/10/2026 18:42" for e-mails and reports. */
export function formatParis(d: Date): string {
  return display.format(d);
}
