import { describe, expect, it } from 'vitest';
import { invoiceSchema } from '@episoft/shared';
import { invoicePayload, type InvoiceFormValues } from './invoice-payload';

const SUPPLIER = '0190a0a0-0000-7000-8000-000000000001';
const values = (over: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
  supplierId: SUPPLIER,
  pieceRef: 'F-2026-001',
  date: '2026-11-02',
  dueDate: '',
  totalExcl: '120,50',
  totalVat: '',
  totalIncl: '120,50',
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
  it('the minimum: supplier, piece, date, total; a blank VAT is 0', () => {
    expect(issues(values())).toEqual([]);
    expect(invoicePayload(values()).totalVat).toBe('0');
    expect(invoicePayload(values({ totalVat: '5', totalIncl: '130' })).totalIncl).toBe('130');
  });
  it('a blank due date is not sent at all', () => {
    expect('dueDate' in JSON.parse(JSON.stringify(invoicePayload(values())))).toBe(false);
    expect(issues(values({ dueDate: '2026-12-02', method: 'TRANSFER' }))).toEqual([]);
  });
  it('names the field of each refusal', () => {
    expect(issues(values({ pieceRef: ' ' }))).toEqual(['pieceRef: N° de pièce requis.']);
    expect(issues(values({ totalExcl: '' }))).toEqual(['totalExcl: Montant invalide.']);
    expect(issues(values({ date: '2/11/2026' }))).toEqual(['date: Date invalide.']);
    expect(issues(values({ supplierId: '' }))).toHaveLength(1);
  });
});
