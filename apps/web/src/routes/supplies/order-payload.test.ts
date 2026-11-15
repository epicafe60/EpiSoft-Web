import { describe, expect, it } from 'vitest';
import { orderLinesPayload } from './order-payload';

const line = (over: Partial<Parameters<typeof orderLinesPayload>[0][number]> = {}) => ({
  productId: 'p1',
  name: 'Miel',
  qty: '0',
  unitPriceExcl: '5',
  ...over,
});

describe('orderLinesPayload (R-CMD-02)', () => {
  it('drops the lines at 0 or empty, even with no price', () => {
    expect(orderLinesPayload([line(), line({ qty: '', unitPriceExcl: '' })])).toEqual({
      ok: true,
      lines: [],
    });
  });
  it('keeps what has a quantity', () => {
    expect(orderLinesPayload([line({ qty: '6' }), line({ productId: 'p2' })])).toEqual({
      ok: true,
      lines: [{ productId: 'p1', qty: '6', unitPriceExcl: '5' }],
    });
  });
  it('refuses an empty or invalid PA HT on an ordered line, naming the product', () => {
    for (const unitPriceExcl of ['', 'abc', '1.23456', '-2']) {
      const r = orderLinesPayload([line({ qty: '2', unitPriceExcl })]);
      expect(r).toMatchObject({ ok: false });
      expect((r as { error: string }).error).toContain('Miel');
    }
  });
  it('refuses an invalid quantity', () => {
    expect(orderLinesPayload([line({ qty: 'x' })])).toMatchObject({ ok: false });
  });
});
