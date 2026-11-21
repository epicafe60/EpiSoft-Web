import { describe, expect, it } from 'vitest';
import { formatBytes, growthPoints, parseDurationInput } from './retention-ui';

describe('retention screen helpers', () => {
  it('writes sizes in plain units', () => {
    expect(formatBytes(0)).toBe('0 o');
    expect(formatBytes(1536)).toMatch(/^1,5 Ko$/);
    expect(formatBytes(5 * 1024 * 1024)).toMatch(/^5 Mo$/);
    expect(formatBytes(-1)).toBe('—');
  });

  it('reads a duration: empty is « Toujours », a whole number of at least 1 otherwise', () => {
    expect(parseDurationInput('')).toBeNull();
    expect(parseDurationInput(' 24 ')).toBe(24);
    expect(parseDurationInput('0')).toBe('invalid');
    expect(parseDurationInput('1,5')).toBe('invalid');
    expect(parseDurationInput('abc')).toBe('invalid');
  });

  it('draws nothing for a single measure, a line for several', () => {
    expect(growthPoints([{ at: '2026-01-01T00:00:00Z', totalBytes: 10 }])).toBe('');
    const pts = growthPoints([
      { at: '2026-01-01T00:00:00Z', totalBytes: 10 },
      { at: '2026-01-08T00:00:00Z', totalBytes: 20 },
    ]).split(' ');
    expect(pts).toHaveLength(2);
    expect(pts[0]!.startsWith('0.0,')).toBe(true);
    expect(pts[1]!.startsWith('600.0,')).toBe(true);
  });
});
