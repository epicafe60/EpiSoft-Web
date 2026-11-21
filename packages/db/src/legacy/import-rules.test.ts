import { describe, expect, it } from 'vitest';
import { invoiceTotalsFromLines, invoiceVatLinesProblem } from '@episoft/shared';
import { isFoodUniverse } from './transform-lot1';
import { estimateInvoiceVatLines } from './transform-lot2';

// The import against the rules of the new application: a food mark by universe, and the breakdown
// of the VAT of an invoice rebuilt from the three totals of the old software (R-TVA-03).

describe('isFoodUniverse', () => {
  it('marks the goods of the food universes, nothing else', () => {
    expect(isFoodUniverse('GOODS', '1')).toBe(true);
    expect(isFoodUniverse('GOODS', '4')).toBe(true);
    expect(isFoodUniverse('GOODS', '5')).toBe(false);
    expect(isFoodUniverse('GOODS', null)).toBe(false);
    expect(isFoodUniverse('SERVICE', '1')).toBe(false);
  });
});

describe('estimateInvoiceVatLines', () => {
  it('puts an invoice without VAT on one line at 0 %', () => {
    expect(estimateInvoiceVatLines('100.00', '0.00')).toEqual({
      lines: [{ rate: '0.00', excl: '100.00', vat: '0.00' }],
      quality: 'EXACT',
      note: '',
    });
  });

  it('keeps one standard rate when it explains the VAT', () => {
    for (const [vat, rate] of [
      ['5.50', '5.50'],
      ['10.00', '10.00'],
      ['20.00', '20.00'],
      ['2.10', '2.10'],
    ] as const) {
      const r = estimateInvoiceVatLines('100.00', vat);
      expect(r.quality).toBe('EXACT');
      expect(r.lines).toEqual([{ rate, excl: '100.00', vat }]);
    }
  });

  it('rebuilds two standard rates around VAT / HT, with the same totals and valid lines', () => {
    const r = estimateInvoiceVatLines('100.00', '12.75');
    expect(r.quality).toBe('ESTIMATED');
    expect(r.lines).toHaveLength(2);
    expect(invoiceVatLinesProblem(r.lines)).toBeNull();
    const t = invoiceTotalsFromLines(r.lines);
    expect(t).toMatchObject({ exclCents: 10000, vatCents: 1275, inclCents: 11275 });
    expect(r.note).toContain('à vérifier');
  });

  it('gives a valid breakdown for any VAT between 0 and 20 % of the HT (property)', () => {
    for (let vatCents = 1; vatCents <= 2000; vatCents += 7) {
      const r = estimateInvoiceVatLines('100.00', (vatCents / 100).toFixed(2));
      expect(['EXACT', 'ESTIMATED', 'APPROXIMATE']).toContain(r.quality);
      const t = invoiceTotalsFromLines(r.lines);
      expect(t.exclCents).toBe(10000);
      expect(t.vatCents).toBe(vatCents);
      if (r.quality !== 'APPROXIMATE') expect(invoiceVatLinesProblem(r.lines)).toBeNull();
    }
  });

  it('keeps the totals on the nearest rate when the VAT fits none, and says so', () => {
    const r = estimateInvoiceVatLines('100.00', '25.00');
    expect(r.quality).toBe('APPROXIMATE');
    expect(r.lines).toEqual([{ rate: '20.00', excl: '100.00', vat: '25.00' }]);
  });

  it('writes no line for an amount that is not an invoice', () => {
    expect(estimateInvoiceVatLines('0.00', '0.00').quality).toBe('NONE');
    expect(estimateInvoiceVatLines('-10.00', '-1.00').lines).toEqual([]);
  });
});
