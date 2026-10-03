import { describe, expect, it } from 'vitest';
import {
  lineVatRate,
  orderStatus,
  transformInvoice,
  type LegacyInvoiceRow,
} from './transform-lot2';

describe('orders (§6.3)', () => {
  it('maps the statuses', () => {
    expect([0, 1, 2, 3, null].map(orderStatus)).toEqual([
      'DRAFT',
      'SENT',
      'RECEIVED',
      'RECEIVED',
      'DRAFT',
    ]);
  });

  it('keeps a legacy VAT rate only when it is a catalogue rate', () => {
    expect(lineVatRate(5.5, '20.00')).toBe('5.50');
    expect(lineVatRate(1.27, '5.50')).toBe('5.50');
    expect(lineVatRate(null, '10.00')).toBe('10.00');
  });
});

const row = (over: Partial<LegacyInvoiceRow> = {}): LegacyInvoiceRow => ({
  FACTID: 12,
  FACTFNR: '0701',
  FACTPIECE: 'F 2026-31',
  FACTDATE: '2026-09-01',
  FACTHT: 100,
  FACTTVA: 5.5,
  FACTTTC: 105.5,
  FACTECH: '2026-10-01',
  FACTETAT: 0,
  FACTMODE: 3,
  FACTLINK: null,
  FACTCOM: 'livraison septembre',
  ...over,
});

describe('supplier invoices (§6.3)', () => {
  it('maps a clean invoice', () => {
    const { draft, issues } = transformInvoice(row());
    expect(issues).toEqual([]);
    expect(draft).toMatchObject({
      pieceRef: 'F 2026-31',
      totalExcl: '100.00',
      totalVat: '5.50',
      totalIncl: '105.50',
      status: 'TO_PAY',
      paymentMethod: 'TRANSFER',
      dueDate: '2026-10-01',
    });
  });

  it('enforces TTC = HT + VAT on float noise and reports real gaps', () => {
    expect(transformInvoice(row({ FACTHT: 0.1 + 0.2, FACTTVA: 0, FACTTTC: 0.3 })).issues).toEqual(
      [],
    );
    const { draft, issues } = transformInvoice(row({ FACTTTC: 106 }));
    expect(draft).toMatchObject({ totalVat: '6.00', totalIncl: '106.00' });
    expect(issues[0]!.field).toBe('FACTTVA');
  });

  it('fixes due dates and empty pieces, keeps the external link in the comment', () => {
    const { draft, issues } = transformInvoice(
      row({ FACTECH: '2026-08-01', FACTPIECE: ' ', FACTLINK: 'C:\\Factures\\x.pdf' }),
    );
    expect(draft.dueDate).toBe('2026-09-01');
    expect(draft.pieceRef).toBe('SANS-REF-12');
    expect(draft.comment).toContain('x.pdf');
    expect(issues.map((i) => i.field).sort()).toEqual(['FACTECH', 'FACTPIECE']);
  });

  it('marks posted invoices as paid and flags an ambiguous mode', () => {
    const { draft, issues } = transformInvoice(row({ FACTETAT: 2, FACTMODE: 0 }));
    expect(draft).toMatchObject({ status: 'PAID', paymentMethod: null });
    expect(issues[0]!.field).toBe('FACTMODE');
  });
});
