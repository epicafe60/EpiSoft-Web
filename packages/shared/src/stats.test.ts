import { describe, expect, it } from 'vitest';
import {
  suggestOrderQtyMilli,
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

describe('suggestOrderQtyMilli', () => {
  const base = {
    stockMilli: 0,
    soldMilli: 30000,
    periodDays: 30,
    targetDays: 30,
    minStockMilli: 0,
    onOrderMilli: 0,
  };
  it('covers the target days at the observed rate', () => {
    expect(suggestOrderQtyMilli(base)).toBe(30000);
    expect(suggestOrderQtyMilli({ ...base, stockMilli: 10000 })).toBe(20000);
  });
  it('subtracts what is already on order and never goes negative', () => {
    expect(suggestOrderQtyMilli({ ...base, onOrderMilli: 12000 })).toBe(18000);
    expect(suggestOrderQtyMilli({ ...base, stockMilli: 99000 })).toBe(0);
  });
  it('treats a negative stock as zero and keeps the minimum stock', () => {
    expect(suggestOrderQtyMilli({ ...base, stockMilli: -5000 })).toBe(30000);
    expect(suggestOrderQtyMilli({ ...base, soldMilli: 0, minStockMilli: 4000 })).toBe(4000);
  });
  it('rounds up and guards a zero-day period', () => {
    expect(suggestOrderQtyMilli({ ...base, soldMilli: 10, periodDays: 3 })).toBe(100);
    expect(suggestOrderQtyMilli({ ...base, soldMilli: 1000, periodDays: 0, targetDays: 1 })).toBe(
      1000,
    );
  });
});
