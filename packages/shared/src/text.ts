/** R-MBR-06: accent- and case-insensitive form used for search and comparisons. */
export function normalizeSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Trims and collapses inner whitespace; empty strings become null. */
export function cleanText(s: string | null | undefined): string | null {
  if (s == null) return null;
  const v = s.replace(/\s+/g, ' ').trim();
  return v === '' ? null : v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}
