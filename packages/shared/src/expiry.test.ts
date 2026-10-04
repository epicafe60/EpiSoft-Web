import { describe, expect, it } from 'vitest';
import { batchSchema, daysUntil, expiryStatus } from './index';

describe('R-STK-07 best-before dates', () => {
  it('counts whole days across month and year ends', () => {
    expect(daysUntil('2026-10-05', '2026-10-04')).toBe(1);
    expect(daysUntil('2027-01-01', '2026-12-31')).toBe(1);
    expect(daysUntil('2026-10-03', '2026-10-04')).toBe(-1);
    expect(daysUntil('2026-10-04', '2026-10-04')).toBe(0);
  });
  it('is expired only once the date is past', () => {
    expect(expiryStatus('2026-10-03', '2026-10-04')).toBe('EXPIRED');
    expect(expiryStatus('2026-10-04', '2026-10-04')).toBe('SOON');
    expect(expiryStatus('2026-10-11', '2026-10-04')).toBe('SOON');
    expect(expiryStatus('2026-10-12', '2026-10-04')).toBe('OK');
    expect(expiryStatus('2026-10-12', '2026-10-04', 10)).toBe('SOON');
  });
  it('validates a batch form', () => {
    const base = {
      productId: '0198f6f2-6f6e-7000-8000-000000000001',
      bestBefore: '2026-11-01',
      qty: '2',
    };
    expect(batchSchema.safeParse(base).success).toBe(true);
    expect(batchSchema.safeParse({ ...base, qty: '0' }).success).toBe(false);
    expect(batchSchema.safeParse({ ...base, bestBefore: '01/11/2026' }).success).toBe(false);
  });
});
