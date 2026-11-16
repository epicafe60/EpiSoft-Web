import { describe, expect, it } from 'vitest';
import { priceGap, receiptPayload, type ReceiveFormLine } from './receipt-payload';

const line = (over: Partial<ReceiveFormLine> = {}): ReceiveFormLine => ({
  orderLineId: null,
  productId: 'p1',
  qty: '2',
  unitPriceExcl: '1.2',
  bestBefore: '',
  newSalePrice: '',
  updateProductPrice: false,
  ...over,
});

describe('receiptPayload', () => {
  it('never asks to update the sheet unless the line is ticked', () => {
    const body = receiptPayload(
      [line(), line({ productId: 'p2', updateProductPrice: true })],
      '2026-11-15',
      false,
    );
    expect(body.lines.map((l) => l.updateProductPrice)).toEqual([false, true]);
  });
  it('drops lines without quantity and keeps the new sale prices of received lines', () => {
    const body = receiptPayload(
      [line({ qty: '0', newSalePrice: '3' }), line({ productId: 'p2', newSalePrice: '4,50' })],
      '2026-11-15',
      true,
    );
    expect(body.lines).toHaveLength(1);
    expect(body.closeOrder).toBe(true);
    expect(body.newSalePrices).toEqual({ p2: '4,50' });
  });
});

describe('priceGap', () => {
  it('gives the amount and the percentage against the reference', () => {
    expect(priceGap('1.0000', '1.1')).toEqual({ amount4: 1000, pct: 10 });
    expect(priceGap('2', '1.5')).toEqual({ amount4: -5000, pct: -25 });
  });
  it('is zero when equal, null without reference, no percentage from 0', () => {
    expect(priceGap('1', '1.0000')).toEqual({ amount4: 0, pct: 0 });
    expect(priceGap(null, '1')).toBeNull();
    expect(priceGap('0', '1')).toEqual({ amount4: 10000, pct: null });
  });
});
