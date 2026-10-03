import { describe, expect, it } from 'vitest';
import {
  inclFromExcl4,
  inventoryAdjustmentMilli,
  invoiceDueDate,
  margin,
  nextSupplierCode,
  orderLineTotals,
  orderTotals,
  parsePrice4,
  price4ToDecimal,
  probableDuplicates,
  roundPrice,
  salePriceForCoefficient,
  salePriceForMarkup,
  stockValueCents,
  suggestedOrderQtyMilli,
} from './supplies';

describe('purchase prices with 4 decimals', () => {
  it('parses and formats', () => {
    expect(parsePrice4('1,2345')).toBe(12345);
    expect(parsePrice4('2')).toBe(20000);
    expect(price4ToDecimal(12345)).toBe('1.2345');
    expect(inclFromExcl4(12000, '5.50')).toBe(12660);
  });
});

describe('orders (R-CMD-01, R-CMD-03)', () => {
  it('suggests max(0, min − stock + reservations)', () => {
    expect(suggestedOrderQtyMilli(5000, 2000)).toBe(3000);
    expect(suggestedOrderQtyMilli(5000, 8000)).toBe(0);
    expect(suggestedOrderQtyMilli(5000, 2000, 1000)).toBe(4000);
    expect(suggestedOrderQtyMilli(null, -3000)).toBe(0);
    expect(suggestedOrderQtyMilli(null, 1000, 3000)).toBe(2000);
  });

  it('computes HT, VAT and TTC per line then adds them up', () => {
    const lines = [
      { qtyMilli: 12_000, unitPriceExcl4: 12_345, vatRate: '5.50' }, // 14.814 → 14.81, VAT 0.81
      { qtyMilli: 3000, unitPriceExcl4: 41_667, vatRate: '20.00' }, // 12.5001 → 12.50, VAT 2.50
    ];
    expect(orderLineTotals(lines[0]!)).toEqual({ exclCents: 1481, vatCents: 81, inclCents: 1562 });
    const t = orderTotals(lines);
    expect(t).toEqual({ exclCents: 2731, vatCents: 331, inclCents: 3062 });
    expect(t.exclCents + t.vatCents).toBe(t.inclCents);
  });
});

describe('margin and selling price (R-PRD-03, Q2)', () => {
  it('gives the markup rate on the selling price and the coefficient', () => {
    expect(margin(250, 12660)).toEqual({ ratePct: 49.36, coefficient: 1.975 });
    expect(margin(250, null)).toBeNull();
  });

  it('rounds to the cent, 5 or 10 cents', () => {
    expect(roundPrice(247, 1)).toBe(247);
    expect(roundPrice(247, 5)).toBe(245);
    expect(roundPrice(248, 5)).toBe(250);
    expect(roundPrice(244, 10)).toBe(240);
    expect(roundPrice(245, 10)).toBe(250);
  });

  it('derives the price from a target rate or coefficient', () => {
    expect(salePriceForMarkup(12660, 30, 5)).toBe(180); // 1.266 / 0.7 = 1.8086
    expect(salePriceForCoefficient(12660, 1.5, 10)).toBe(190); // 1.899
    expect(salePriceForMarkup(12660, 100, 1)).toBeNull();
  });
});

describe('suppliers and invoices', () => {
  it('proposes region + sequence without a limit of 99 (R-FNR-01)', () => {
    expect(nextSupplierCode(['0701', '0702', '0910'], '07')).toBe('0703');
    expect(nextSupplierCode([], '9')).toBe('0901');
    expect(nextSupplierCode(['0799'], '07')).toBe('07100');
  });

  it('computes the due date (R-FAC-01)', () => {
    expect(invoiceDueDate('2026-10-03', 30)).toBe('2026-11-02');
  });

  it('flags probable duplicates (R-FAC-05)', () => {
    const others = [
      { id: 'a', supplierId: 's', pieceRef: 'F 123', date: '2026-10-01', totalIncl: '50.00' },
      { id: 'b', supplierId: 's', pieceRef: 'F124', date: '2026-09-01', totalIncl: '80.00' },
      { id: 'c', supplierId: 't', pieceRef: 'F123', date: '2026-10-01', totalIncl: '50.00' },
    ];
    expect(
      probableDuplicates(
        { supplierId: 's', pieceRef: 'f123', date: '2026-10-20', totalIncl: '10' },
        others,
      ).map((o) => o.id),
    ).toEqual(['a']);
    expect(
      probableDuplicates(
        { supplierId: 's', pieceRef: 'X', date: '2026-10-05', totalIncl: '50' },
        others,
      ).map((o) => o.id),
    ).toEqual(['a']);
    expect(
      probableDuplicates(
        { supplierId: 's', pieceRef: 'X', date: '2026-10-20', totalIncl: '50' },
        others,
      ),
    ).toEqual([]);
  });
});

describe('inventory (R-STK-04) and valuation (R-STK-06)', () => {
  it('CA: a sale during the inventory is not counted twice', () => {
    // 10 in stock at opening, 2 sold before the count, 7 counted → −1.
    expect(inventoryAdjustmentMilli(10_000, -2000, 7000)).toBe(-1000);
    // The same sale made after the count does not change the adjustment.
    expect(inventoryAdjustmentMilli(10_000, 0, 9000)).toBe(-1000);
  });

  it('values positive stock at the purchase price', () => {
    expect(stockValueCents(2500, 12_000)).toBe(300);
    expect(stockValueCents(-2000, 12_000)).toBe(0);
  });
});
