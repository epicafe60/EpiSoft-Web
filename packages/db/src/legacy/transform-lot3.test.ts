import { describe, expect, it } from 'vitest';
import {
  accountSide,
  calendarYear,
  entryModeOf,
  lineDifference,
  matchInvoices,
  numberMovements,
  parseModels,
  planLines,
  sixDigitAccount,
} from './transform-lot3';

describe('legacy accounting transforms (spec §6 epicompta)', () => {
  it('maps account types and payment modes', () => {
    expect(accountSide('C')).toBe('C');
    expect(accountSide('D')).toBe('D');
    expect(accountSide('M')).toBe('M');
    expect(accountSide('')).toBe('M');
    expect([0, 1, 2, 3, 4, 5].map(entryModeOf)).toEqual([
      'CASH',
      'CHEQUE',
      'CARD',
      'TRANSFER',
      'DIRECT_DEBIT',
      'OTHER',
    ]);
    expect(entryModeOf(9)).toBeNull();
  });

  it('shortens the 8-digit guide accounts, the old bank sub-account goes to the bank', () => {
    const known = new Set(['615000', '616100', '627000', '512001']);
    expect(sixDigitAccount(707000, known, '512001')).toBe('707000');
    expect(sixDigitAccount(61500000, known, '512001')).toBe('615000');
    expect(sixDigitAccount(51211000, known, '512001')).toBe('512001');
    expect(sixDigitAccount(99900000, known, '512001')).toBeNull();
  });

  it('rounds float amounts to the cent and splits a line with both sides', () => {
    const lines = planLines([
      { account: 607000, label: ' Achats ', debit: 12.344999999, credit: 0 },
      { account: 401001, label: 'X', debit: 0, credit: 12.34 },
      { account: 411000, label: 'mixte', debit: 5, credit: 3 },
      { account: 531000, label: 'vide', debit: 0, credit: 0 },
    ]);
    expect(lines).toEqual([
      { account: '607000', label: 'Achats', debitCents: 1234, creditCents: 0 },
      { account: '401001', label: 'X', debitCents: 0, creditCents: 1234 },
      { account: '411000', label: 'mixte', debitCents: 500, creditCents: 0 },
      { account: '411000', label: 'mixte', debitCents: 0, creditCents: 300 },
    ]);
    expect(lineDifference(lines)).toBe(200);
  });

  it('turns a negative invoice (credit note) into opposite-side lines, still balanced', () => {
    const lines = planLines([
      { account: 607000, label: 'avoir', debit: -40.05, credit: 0 },
      { account: 401001, label: 'avoir', debit: 0, credit: -40.05 },
    ]);
    expect(lines).toEqual([
      { account: '607000', label: 'avoir', debitCents: 0, creditCents: 4005 },
      { account: '401001', label: 'avoir', debitCents: 4005, creditCents: 0 },
    ]);
    expect(lineDifference(lines)).toBe(0);
  });

  it('closes past calendar years only', () => {
    expect(calendarYear('2025-06-30', '2026-10-04')).toMatchObject({
      label: 'Exercice 2025',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      status: 'CLOSED',
    });
    expect(calendarYear('2026-02-01', '2026-10-04').status).toBe('OPEN');
  });

  it('numbers validated movements per journal and year by date then legacy number', () => {
    const n = numberMovements([
      { mvtnum: 3, date: '2025-07-02', journal: 'BNQ', fiscalYear: '2025' },
      { mvtnum: 1, date: '2025-07-02', journal: 'BNQ', fiscalYear: '2025' },
      { mvtnum: 2, date: '2025-06-30', journal: 'BNQ', fiscalYear: '2025' },
      { mvtnum: 9, date: '2025-06-30', journal: 'ACH', fiscalYear: '2025' },
    ]);
    expect(n.get(2)).toBe(1);
    expect(n.get(1)).toBe(2);
    expect(n.get(3)).toBe(3);
    expect(n.get(9)).toBe(1);
  });

  it('reads Models.txt: file order is the priority, direction follows the bank side (C15)', () => {
    const rules = parseModels(
      [
        'CPteDeb,CpteCre,RgltMode,StartLibPos, TextToFind',
        '512001,411000,3,25=FAVEUR',
        '401011,512001,3,14=BRUNNEVAL ',
        '512001,511200,1,1=REMISE DE CHEQUE',
        'n’importe quoi',
        '',
      ].join('\r\n'),
      '512001',
    );
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({
      priority: 10,
      direction: 'IN',
      counterAccount: '411000',
      text: 'FAVEUR',
      mode: 'TRANSFER',
    });
    expect(rules[1]).toMatchObject({
      priority: 20,
      direction: 'OUT',
      counterAccount: '401011',
      text: 'BRUNNEVAL',
    });
    expect(rules[2]).toMatchObject({ direction: 'IN', counterAccount: '511200', mode: 'CHEQUE' });
  });

  it('links entries to invoices: same supplier and amount, closest date, no ties', () => {
    const invoices = [
      { id: 'i1', supplierAccount: '401001', date: '2026-01-10', totalCents: 9545 },
      { id: 'i2', supplierAccount: '401001', date: '2026-02-20', totalCents: 9545 },
      { id: 'i3', supplierAccount: '401002', date: '2026-01-10', totalCents: 5000 },
      { id: 'i4', supplierAccount: '401003', date: '2026-03-01', totalCents: 1000 },
      { id: 'i5', supplierAccount: '401003', date: '2026-03-01', totalCents: 1000 },
    ];
    const { pairs, unmatched } = matchInvoices(
      [
        { mvtnum: 1, date: '2026-01-12', supplierAccount: '401001', cents: 9545 },
        { mvtnum: 2, date: '2026-02-19', supplierAccount: '401001', cents: 9545 },
        { mvtnum: 3, date: '2026-01-10', supplierAccount: '401002', cents: 4999 },
        { mvtnum: 4, date: '2026-03-01', supplierAccount: '401003', cents: 1000 },
      ],
      invoices,
    );
    expect(pairs).toEqual([
      { mvtnum: 1, invoiceId: 'i1' },
      { mvtnum: 2, invoiceId: 'i2' },
    ]);
    expect(unmatched).toEqual([3, 4]);
  });
});
