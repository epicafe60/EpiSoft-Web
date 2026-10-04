import { describe, expect, it } from 'vitest';
import { filterRows, matchesColumnFilter, sortRows } from './sort';

describe('sortRows', () => {
  it('sorts text the French way, accents and case ignored', () => {
    expect(sortRows(['été', 'Zèbre', 'abri', 'Eau'], (s) => s, 'asc')).toEqual([
      'abri',
      'Eau',
      'été',
      'Zèbre',
    ]);
  });
  it('sorts numbers, and numbers inside text, naturally', () => {
    expect(sortRows([10, 9, 100], (n) => n, 'desc')).toEqual([100, 10, 9]);
    expect(sortRows(['F10', 'F9'], (s) => s, 'asc')).toEqual(['F9', 'F10']);
  });
  it('keeps empty values last in both directions and ties stable', () => {
    const rows = [
      { k: null, n: 1 },
      { k: 2, n: 2 },
      { k: 2, n: 3 },
      { k: 1, n: 4 },
    ];
    expect(sortRows(rows, (r) => r.k, 'asc').map((r) => r.n)).toEqual([4, 2, 3, 1]);
    expect(sortRows(rows, (r) => r.k, 'desc').map((r) => r.n)).toEqual([2, 3, 4, 1]);
  });
});

describe('column filters', () => {
  it('text: accent and case insensitive contains; empty query matches everything', () => {
    expect(matchesColumnFilter('Hélène Dupré', 'helene')).toBe(true);
    expect(matchesColumnFilter('Hélène Dupré', 'DUPRE')).toBe(true);
    expect(matchesColumnFilter('Hélène', 'marc')).toBe(false);
    expect(matchesColumnFilter(null, '')).toBe(true);
    expect(matchesColumnFilter(null, 'a')).toBe(false);
  });
  it('ISO dates can be searched as dd/mm/yyyy', () => {
    expect(matchesColumnFilter('2026-10-04T09:00:00Z', '04/10/2026')).toBe(true);
    expect(matchesColumnFilter('2026-10-04', '2026-10')).toBe(true);
    expect(matchesColumnFilter('2026-10-04', '05/10')).toBe(false);
  });
  it('numbers: comparison operators with comma decimals, or contained digits', () => {
    expect(matchesColumnFilter(12.5, '>10')).toBe(true);
    expect(matchesColumnFilter(12.5, '<=12,5')).toBe(true);
    expect(matchesColumnFilter(12.5, '<12')).toBe(false);
    expect(matchesColumnFilter(7, '=7')).toBe(true);
    expect(matchesColumnFilter(-3, '<0')).toBe(true);
    expect(matchesColumnFilter(1250, '125')).toBe(true);
    expect(matchesColumnFilter(12.5, '12,5')).toBe(true);
  });
  it('filterRows combines columns with AND and ignores unknown keys', () => {
    const rows = [
      { n: 'Pain', p: 2 },
      { n: 'Pâtes', p: 3 },
      { n: 'Miel', p: 9 },
    ];
    const acc = { n: (r: (typeof rows)[number]) => r.n, p: (r: (typeof rows)[number]) => r.p };
    expect(filterRows(rows, acc, { n: 'pa', p: '>2' }).map((r) => r.n)).toEqual(['Pâtes']);
    expect(filterRows(rows, acc, { zzz: 'x' })).toHaveLength(3);
  });
});
