import { describe, expect, it } from 'vitest';
import { isoDate, isRealCalendarDate, pastOrTodayDate, shopToday } from './dates';
import { invoiceSchema, receiptSchema } from './supplies-forms';
import { walletTopupSchema, membershipCreateSchema } from './forms';

describe('real calendar date', () => {
  it('accepts days that exist, including 29 February of a leap year', () => {
    expect(isRealCalendarDate('2026-02-28')).toBe(true);
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
    expect(isoDate.safeParse('2026-12-31').success).toBe(true);
  });
  it('refuses days that do not exist', () => {
    for (const d of [
      '2026-02-30',
      '2027-02-29',
      '2026-13-45',
      '2026-00-10',
      '2026-04-31',
      '2026-1-1',
    ])
      expect(isoDate.safeParse(d).success, d).toBe(false);
  });
  it('refuses implausible years', () => {
    expect(isoDate.safeParse('1899-01-01').success).toBe(false);
    expect(isoDate.safeParse('2500-01-01').success).toBe(false);
  });
  it('a past-or-today date refuses tomorrow', () => {
    const t = new Date(Date.now() + 3 * 86_400_000);
    const future = shopToday(t);
    expect(pastOrTodayDate.safeParse(shopToday()).success).toBe(true);
    const r = pastOrTodayDate.safeParse(future);
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0]!.message).toBe('La date ne peut pas être dans le futur.');
  });
});

describe('the forms use the one date schema', () => {
  const uuid = '0190b2c0-0000-7000-8000-000000000000';
  it('top-up, membership, invoice and receipt refuse 2026-02-30', () => {
    expect(
      walletTopupSchema.safeParse({ amount: '10', method: 'CASH', date: '2026-02-30' }).success,
    ).toBe(false);
    expect(
      membershipCreateSchema.safeParse({ typeId: uuid, method: 'CASH', date: '2026-13-45' })
        .success,
    ).toBe(false);
    expect(
      invoiceSchema.safeParse({
        supplierId: uuid,
        pieceRef: 'F1',
        date: '2026-02-30',
        totalExcl: '10',
        totalVat: '1',
        totalIncl: '11',
        paymentMethod: null,
        comment: '',
      }).success,
    ).toBe(false);
    expect(
      receiptSchema.safeParse({
        date: '2026-02-30',
        lines: [{ orderLineId: null, productId: uuid, qty: '1', unitPriceExcl: '1' }],
      }).success,
    ).toBe(false);
  });
});
