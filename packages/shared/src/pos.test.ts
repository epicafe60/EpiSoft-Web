import { describe, expect, it } from 'vitest';
import {
  applyPayment,
  closing,
  countedCashCents,
  estimatedBalanceCents,
  formatSaleNumber,
  isValidEan,
  lineTotalCents,
  lookupProduct,
  membershipEnd,
  membershipPeriod,
  membershipState,
  milliToDecimal,
  parseQtyToMilli,
  paymentState,
  percentDiscountCents,
  saleTotalCents,
  walletPaymentAllowed,
} from './pos';

describe('quantities (R-VTE-04)', () => {
  it('parses three decimals with comma or dot', () => {
    expect(parseQtyToMilli('0,25')).toBe(250);
    expect(parseQtyToMilli('1.234')).toBe(1234);
    expect(parseQtyToMilli('2')).toBe(2000);
    expect(parseQtyToMilli('1,2345')).toBeNull();
    expect(milliToDecimal(250)).toBe('0.250');
    expect(milliToDecimal(-1500)).toBe('-1.500');
  });
});

describe('line and sale totals (§6.2)', () => {
  it('rounds each line to the cent, half away from zero', () => {
    // 0.333 kg × 12.90 €/kg = 4.2957 → 4.30
    expect(lineTotalCents({ qtyMilli: 333, unitPriceCents: 1290, discountCents: 0 })).toBe(430);
    // 0.125 × 0.10 = 0.0125 → 0.01
    expect(lineTotalCents({ qtyMilli: 125, unitPriceCents: 10, discountCents: 0 })).toBe(1);
    // cancellation lines are symmetric
    expect(lineTotalCents({ qtyMilli: -333, unitPriceCents: 1290, discountCents: 0 })).toBe(-430);
  });

  it('subtracts the discount and sums the lines', () => {
    const lines = [
      { qtyMilli: 3000, unitPriceCents: 20, discountCents: 0 },
      { qtyMilli: 1000, unitPriceCents: 450, discountCents: 50 },
    ];
    expect(saleTotalCents(lines)).toBe(60 + 400);
  });

  it('computes a percentage discount (R-VTE-07)', () => {
    expect(percentDiscountCents({ qtyMilli: 2000, unitPriceCents: 333 }, 10)).toBe(67);
  });
});

describe('payments (R-VTE-09)', () => {
  it('only cash gives change', () => {
    expect(applyPayment(1750, 'CASH', 2000)).toEqual({ amountCents: 1750, changeCents: 250 });
    expect(applyPayment(1750, 'CARD', 2000)).toEqual({ amountCents: 1750, changeCents: 0 });
    expect(applyPayment(0, 'CASH', 500)).toEqual({ amountCents: 0, changeCents: 0 });
  });

  it('recomputes the remaining amount after each payment', () => {
    expect(paymentState(1000, [{ method: 'WALLET', amountCents: 400 }])).toEqual({
      paidCents: 400,
      remainingCents: 600,
      settled: false,
    });
    expect(
      paymentState(1000, [
        { method: 'WALLET', amountCents: 400 },
        { method: 'CASH', amountCents: 600 },
      ]).settled,
    ).toBe(true);
  });
});

describe('cagnotte (R-CAG-04, R-OFF-04)', () => {
  it('refuses a payment beyond the overdraft limit', () => {
    expect(walletPaymentAllowed(500, 500, 0)).toBe(true);
    expect(walletPaymentAllowed(500, 501, 0)).toBe(false);
    expect(walletPaymentAllowed(500, 1000, 500)).toBe(true);
  });

  it('CA §4.3: two members of a household buying 10 € each lower its balance by 20 €', () => {
    const pending = [
      { householdId: 'h1', amountCents: -1000 },
      { householdId: 'h1', amountCents: -1000 },
      { householdId: 'h2', amountCents: -500 },
    ];
    expect(estimatedBalanceCents('h1', 5000, pending)).toBe(3000);
  });
});

describe('closing (R-SES-02)', () => {
  it('counts the 12 face values', () => {
    expect(countedCashCents({ '5000': 1, '200': 3, '1': 4, '7': 99 })).toBe(5000 + 600 + 4);
  });

  it('CA §4.5: float 100, cash sales 50, memberships in cash 12, top-up by cheque 20 → 162', () => {
    const r = closing({
      openingFloatCents: 10000,
      cashSalesCents: 5000,
      cashOtherCents: 1200,
      countedCashCents: 16000,
      bankDepositCents: 6000,
    });
    expect(r).toEqual({ expectedCashCents: 16200, differenceCents: -200, nextFloatCents: 10000 });
  });
});

describe('memberships (R-ADH-02)', () => {
  it('ends the day before the anniversary', () => {
    expect(membershipEnd('2026-10-15', 12)).toBe('2027-10-14');
    expect(membershipEnd('2024-02-29', 12)).toBe('2025-02-27');
    expect(membershipEnd('2026-01-31', 1)).toBe('2026-02-27');
  });

  it('a passing membership lasts the day itself', () => {
    expect(membershipEnd('2026-10-03', 0)).toBe('2026-10-03');
    expect(membershipPeriod('2026-10-03', 0, '2027-01-01')).toEqual({
      start: '2026-10-03',
      end: '2026-10-03',
    });
  });

  it('a renewal starts after the current membership', () => {
    expect(membershipPeriod('2026-10-03', 12, '2026-10-14')).toEqual({
      start: '2026-10-15',
      end: '2027-10-14',
    });
    expect(membershipPeriod('2026-10-03', 12, '2026-09-01')).toEqual({
      start: '2026-10-03',
      end: '2027-10-02',
    });
  });

  it('tells valid from expired (R-ADH-03)', () => {
    expect(membershipState('2026-10-03', '2026-10-03')).toBe('VALID');
    expect(membershipState('2026-10-02', '2026-10-03')).toBe('EXPIRED');
    expect(membershipState(null, '2026-10-03')).toBe('NONE');
  });
});

describe('product lookup (R-VTE-03)', () => {
  const products = [
    { id: 'a', code: '111001', name: 'Chips nature Lays 155g', eans: ['3168930167983'] },
    { id: 'b', code: '111002', name: 'Chips paprika', eans: [] },
    { id: 'c', code: '320037', name: 'Bananes bio', eans: [] },
  ];

  it('finds by exact EAN, then exact code', () => {
    expect(lookupProduct(products, '3168930167983')).toEqual({
      kind: 'found',
      product: products[0],
    });
    expect(lookupProduct(products, '111002')).toEqual({ kind: 'found', product: products[1] });
  });

  it('CA §4.4: an unknown EAN never adds another product', () => {
    expect(lookupProduct(products, '316893016798')).toEqual({ kind: 'none' });
    expect(lookupProduct(products, '1110')).toEqual({ kind: 'none' });
  });

  it('a text search returns choices, accent and case insensitive', () => {
    expect(lookupProduct(products, 'CHIPS')).toMatchObject({
      kind: 'choices',
      products: [{ id: 'a' }, { id: 'b' }],
    });
    expect(lookupProduct(products, 'bananes BIO')).toMatchObject({
      kind: 'choices',
      products: [{ id: 'c' }],
    });
  });
});

describe('barcodes and numbers', () => {
  it('validates EAN check digits', () => {
    expect(isValidEan('3168930167983')).toBe(true);
    expect(isValidEan('3168930167984')).toBe(false);
    expect(isValidEan('96385074')).toBe(true);
  });

  it('formats ticket numbers (R-VTE-10)', () => {
    expect(formatSaleNumber(2026, 124)).toBe('T-2026-000124');
  });
});
