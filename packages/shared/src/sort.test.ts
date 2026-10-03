import { describe, expect, it } from 'vitest';
import { sortRows } from './sort';

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
    const rows = [{ k: null, n: 1 }, { k: 2, n: 2 }, { k: 2, n: 3 }, { k: 1, n: 4 }];
    expect(sortRows(rows, (r) => r.k, 'asc').map((r) => r.n)).toEqual([4, 2, 3, 1]);
    expect(sortRows(rows, (r) => r.k, 'desc').map((r) => r.n)).toEqual([2, 3, 4, 1]);
  });
});
