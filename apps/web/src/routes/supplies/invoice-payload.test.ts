import { describe, expect, it } from 'vitest';
import { invoiceSchema, resolveInvoiceAmounts } from '@episoft/shared';
import { invoicePayload, type InvoiceFormValues } from './invoice-payload';

const SUPPLIER = '0190a0a0-0000-7000-8000-000000000001';
const values = (over: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
  supplierId: SUPPLIER,
  pieceRef: 'F-2026-001',
  date: '2026-11-02',
  dueDate: '',
  lines: [{ rate: '5.50', excl: '100', vat: '5,50' }],
  totalIncl: '',
  method: '',
  comment: '',
  receiptIds: [],
  ...over,
});
const issues = (v: InvoiceFormValues) => {
  const r = invoiceSchema.safeParse(invoicePayload(v));
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('the invoice form produces a payload the schema accepts', () => {
  it('liable: supplier, piece, date and a VAT line; a blank VAT is 0', () => {
    expect(issues(values())).toEqual([]);
    expect(
      invoicePayload(values({ lines: [{ rate: '0.00', excl: '10', vat: '' }] })).vatLines[0]?.vat,
    ).toBe('0');
    expect(issues(values({ lines: [{ rate: '0.00', excl: '10', vat: '' }] }))).toEqual([]);
  });
  it('blank lines are dropped; with no line the total TTC alone is sent (franchise, exempt)', () => {
    const v = values({ lines: [{ rate: '20.00', excl: '', vat: '' }], totalIncl: '120,50' });
    const p = invoicePayload(v);
    expect(p.vatLines).toEqual([]);
    expect(p.totalIncl).toBe('120,50');
    expect(issues(v)).toEqual([]);
    const parsed = invoiceSchema.parse(p);
    expect(resolveInvoiceAmounts('FRANCHISE', parsed)).toMatchObject({
      ok: true,
      totalIncl: '120.50',
    });
    expect(resolveInvoiceAmounts('LIABLE', parsed)).toMatchObject({ ok: false });
  });
  it('with a breakdown the total is not sent', () => {
    expect(invoicePayload(values({ totalIncl: '999' })).totalIncl).toBeUndefined();
  });
  it('a blank due date is not sent at all', () => {
    expect('dueDate' in JSON.parse(JSON.stringify(invoicePayload(values())))).toBe(false);
    expect(issues(values({ dueDate: '2026-12-02', method: 'TRANSFER' }))).toEqual([]);
  });
  it('names the field of each refusal', () => {
    expect(issues(values({ pieceRef: ' ' }))).toEqual(['pieceRef: N° de pièce requis.']);
    expect(issues(values({ lines: [], totalIncl: '' }))).toHaveLength(1);
    expect(issues(values({ lines: [{ rate: '5.50', excl: '100', vat: '9' }] }))[0]).toMatch(
      /^vatLines: Ligne 1/,
    );
    expect(issues(values({ date: '2/11/2026' }))).toEqual(['date: Date invalide.']);
    expect(issues(values({ supplierId: '' }))).toHaveLength(1);
  });
});
