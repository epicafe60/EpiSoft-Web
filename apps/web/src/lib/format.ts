import { formatEuro } from '@episoft/shared';

const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' });

/** "2026-10-03" → "03/10/2026" (§5.1). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return date.format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso));
}

export function euro(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : formatEuro(v);
}

/** Today in the device's local time, YYYY-MM-DD. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
