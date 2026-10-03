import { describe, expect, it } from 'vitest';
import {
  canTransition,
  cartTotalCents,
  memberCanCancel,
  mergeCartLines,
  pickupDateValid,
  preorderSchema,
} from './preorders';

const id = '0190a000-0000-7000-8000-000000000001';

describe('pre-orders (R-PRE-01..03)', () => {
  it('merges repeated products and adds their quantities', () => {
    const merged = mergeCartLines([
      { productId: 'a', qty: '1.000' },
      { productId: 'b', qty: '0.250' },
      { productId: 'a', qty: '2.500' },
    ]);
    expect(merged).toEqual([
      { productId: 'a', qty: '3.500' },
      { productId: 'b', qty: '0.250' },
    ]);
  });
  it('totals the cart in cents', () => {
    expect(
      cartTotalCents([
        { qty: '2.000', unitPriceCents: 250 },
        { qty: '0.350', unitPriceCents: 1290 },
      ]),
    ).toBe(500 + 452);
  });
  it('validates the order form', () => {
    expect(preorderSchema.safeParse({ pickupDate: '2026-10-10', lines: [] }).success).toBe(false);
    expect(
      preorderSchema.safeParse({ pickupDate: '2026-10-10', lines: [{ productId: id, qty: '0' }] })
        .success,
    ).toBe(false);
    const ok = preorderSchema.parse({
      pickupDate: '2026-10-10',
      lines: [{ productId: id, qty: '2' }],
    });
    expect(ok.lines[0]!.qty).toBe('2.000');
  });
  it('follows the status flow', () => {
    expect(canTransition('SUBMITTED', 'READY')).toBe(true);
    expect(canTransition('READY', 'PICKED_UP')).toBe(true);
    expect(canTransition('SUBMITTED', 'PICKED_UP')).toBe(false);
    expect(canTransition('PICKED_UP', 'CANCELLED')).toBe(false);
    expect(memberCanCancel('SUBMITTED')).toBe(true);
    expect(memberCanCancel('READY')).toBe(false);
  });
  it('refuses a pick-up date in the past', () => {
    expect(pickupDateValid('2026-10-04', '2026-10-04')).toBe(true);
    expect(pickupDateValid('2026-10-03', '2026-10-04')).toBe(false);
  });
});
