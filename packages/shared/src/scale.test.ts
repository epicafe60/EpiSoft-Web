import { describe, expect, it } from 'vitest';
import { lineTotalCents } from './pos';
import { decodeScaleBarcode, productForPlu, scaleQuantityMilli } from './scale';

/** Builds a valid scale EAN-13 for the tests. */
function ean(body12: string): string {
  const digits = body12.split('').map(Number);
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return body12 + ((10 - (sum % 10)) % 10);
}

describe('scale barcodes (R-VTE-04)', () => {
  it('decodes prefix, PLU and value', () => {
    expect(decodeScaleBarcode(ean('210003700745'), 'WEIGHT')).toEqual({
      plu: '00037',
      kind: 'WEIGHT',
      value: 745,
    });
    expect(decodeScaleBarcode(ean('210003700745'), 'PRICE')).toMatchObject({ value: 745 });
  });

  it('refuses ordinary EANs and wrong check digits', () => {
    expect(decodeScaleBarcode('3168930167983', 'PRICE')).toBeNull();
    expect(decodeScaleBarcode('2100037007450', 'PRICE')).toBeNull();
  });

  it('matches the PLU to a single product', () => {
    const products = [{ code: '320037' }, { code: '320038' }, { code: '37' }];
    expect(productForPlu(products, '20037')).toEqual({ code: '320037' });
    expect(productForPlu([{ code: '120037' }, { code: '320037' }], '20037')).toBeNull();
  });

  it('turns grams into the sale unit', () => {
    const label = { plu: '20037', kind: 'WEIGHT' as const, value: 745 };
    expect(scaleQuantityMilli(label, 320, 'KG')).toBe(745);
    expect(scaleQuantityMilli(label, 1, 'G')).toBe(745_000);
  });

  it('finds the quantity whose amount is the printed price', () => {
    const label = { plu: '20037', kind: 'PRICE' as const, value: 238 };
    const q = scaleQuantityMilli(label, 320, 'KG')!;
    expect(lineTotalCents({ qtyMilli: q, unitPriceCents: 320, discountCents: 0 })).toBe(238);
  });
});
