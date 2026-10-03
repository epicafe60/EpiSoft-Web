// Money helpers. Amounts travel as decimal strings ("12.50"), like PostgreSQL numeric,
// and are computed in integer cents. Never use floating point for money (spec §5.2).

const AMOUNT_RE = /^([+-])?(\d+)(?:[.,](\d+))?$/;

/**
 * Parses an amount typed by a user, with a comma or a dot (spec §5.1).
 * Spaces (thousands separators) are ignored. Rounds half up to the cent.
 * Returns null when the input is not a number.
 */
export function parseAmountToCents(input: string): number | null {
  const s = input.replace(/[\s\u00a0\u202f€]/g, '');
  const m = AMOUNT_RE.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const units = Number(m[2]);
  const frac = (m[3] ?? '').padEnd(3, '0');
  let cents = units * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return sign * cents;
}

export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function decimalToCents(value: string): number {
  const cents = parseAmountToCents(value);
  if (cents === null) throw new Error(`Montant invalide : ${value}`);
  return cents;
}

const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/** French display: "1 234,50 €". */
export function formatEuro(value: string | number): string {
  const cents = typeof value === 'number' ? Math.round(value * 100) : decimalToCents(value);
  return EUR.format(cents / 100);
}
