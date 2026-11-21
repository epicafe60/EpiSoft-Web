/** Size in the unit a volunteer reads: « 12,4 Mo ». */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${units[i]}`;
}

/** The text of a duration input: « Toujours » is an empty value, a number is days or months. */
export function parseDurationInput(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return 'invalid';
  const n = Number(t);
  return n >= 1 ? n : 'invalid';
}

/** Points of the growth curve (viewBox 0..W, 0..H) from the stored snapshots. */
export function growthPoints(
  snapshots: { at: string; totalBytes: number }[],
  w = 600,
  h = 140,
): string {
  if (snapshots.length < 2) return '';
  const times = snapshots.map((s) => new Date(s.at).getTime());
  const t0 = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - t0);
  const max = Math.max(...snapshots.map((s) => s.totalBytes), 1);
  return snapshots
    .map(
      (s, i) =>
        `${(((times[i]! - t0) / span) * w).toFixed(1)},${(h - (s.totalBytes / max) * (h - 8) - 4).toFixed(1)}`,
    )
    .join(' ');
}
