import { describe, expect, it } from 'vitest';
import {
  averageBasketCents,
  expiresWithin,
  grossMargin,
  periodRange,
  sameDayLastYear,
  variationPercent,
} from './stats';

describe('periodRange (R-STA-02)', () => {
  it('day compares with the same day last year', () => {
    expect(periodRange('day', '2026-10-04')).toEqual({
      current: { from: '2026-10-04', to: '2026-10-04' },
      previous: { from: '2025-10-04', to: '2025-10-04' },
    });
  });
  it('week starts on Monday', () => {
    expect(periodRange('week', '2026-10-04').current.from).toBe('2026-09-28'); // Sunday
    expect(periodRange('week', '2026-10-05').current.from).toBe('2026-10-05'); // Monday
  });
  it('month and year are to date', () => {
    const m = periodRange('month', '2026-10-04');
    expect(m.current).toEqual({ from: '2026-10-01', to: '2026-10-04' });
    expect(m.previous).toEqual({ from: '2025-10-01', to: '2025-10-04' });
    expect(periodRange('year', '2026-10-04').current.from).toBe('2026-01-01');
  });
  it('29 February falls back', () => {
    expect(sameDayLastYear('2028-02-29')).toBe('2027-02-28');
  });
});

describe('figures', () => {
  it('variation', () => {
    expect(variationPercent(120, 100)).toBe(20);
    expect(variationPercent(80, 100)).toBe(-20);
    expect(variationPercent(10, 0)).toBeNull();
  });
  it('average basket', () => {
    expect(averageBasketCents(1000, 3)).toBe(333);
    expect(averageBasketCents(0, 0)).toBe(0);
  });
  it('gross margin', () => {
    expect(grossMargin(1000, 700)).toEqual({ marginCents: 300, ratePercent: 30 });
    expect(grossMargin(0, 0).ratePercent).toBeNull();
  });
  it('expiring membership', () => {
    expect(expiresWithin('2026-10-20', '2026-10-04', 30)).toBe(true);
    expect(expiresWithin('2026-12-20', '2026-10-04', 30)).toBe(false);
    expect(expiresWithin('2026-10-03', '2026-10-04', 30)).toBe(false);
  });
});
