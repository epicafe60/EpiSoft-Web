import { describe, expect, it } from 'vitest';
import {
  balancingAmount,
  buildBankLineEntry,
  buildCarryForwardEntry,
  buildDepositEntry,
  buildInvoiceEntry,
  buildInvoicePaymentEntry,
  buildResultEntry,
  buildSessionEntry,
  buildStockVariationEntry,
  checkEntry,
  DEFAULT_ACCOUNTS as A,
  defaultNormalSide,
  fiscalYearFor,
  formatEntryNumber,
  reverseLines,
  yearResultCents,
  type AccountBalance,
  type PlannedLine,
} from './accounting';

const asInput = (lines: PlannedLine[]) =>
  lines.map((l) => ({
    accountId: l.account,
    label: l.label,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
  }));
const bal = (number: string, d: number, c: number): AccountBalance => ({
  number,
  label: number,
  debitCents: d,
  creditCents: c,
});

describe('entry check (R-CPT-04)', () => {
  const ok = [
    { accountId: 'a', label: '', debitCents: 1000, creditCents: 0 },
    { accountId: 'b', label: '', debitCents: 0, creditCents: 1000 },
  ];

  it('accepts a balanced entry', () => {
    expect(checkEntry(ok)).toMatchObject({ balanced: true, diffCents: 0, errors: [] });
  });

  it('rejects an unbalanced entry to the cent', () => {
    const r = checkEntry([ok[0]!, { ...ok[1]!, creditCents: 999 }]);
    expect(r.balanced).toBe(false);
    expect(r.errors[0]).toMatch(/déséquilibrée/);
  });

  it('rejects debit and credit on one line, missing accounts, zero lines and single lines', () => {
    expect(
      checkEntry([
        { accountId: 'a', label: '', debitCents: 5, creditCents: 5 },
        ok[1]!,
      ]).errors.join(),
    ).toMatch(/débit et crédit/);
    expect(checkEntry([{ ...ok[0]!, accountId: null }, ok[1]!]).errors.join()).toMatch(
      /compte manquant/,
    );
    expect(checkEntry([{ ...ok[0]!, debitCents: 0 }, ok[1]!]).errors.join()).toMatch(/montant nul/);
    expect(checkEntry([ok[0]!]).errors.join()).toMatch(/au moins deux lignes/);
  });

  it('proposes the balancing amount (R-CPT-07 "solder")', () => {
    expect(
      balancingAmount([
        { debitCents: 1500, creditCents: 0 },
        { debitCents: 0, creditCents: 500 },
      ]),
    ).toEqual({ side: 'credit', cents: 1000 });
    expect(
      balancingAmount([
        { debitCents: 100, creditCents: 0 },
        { debitCents: 0, creditCents: 300 },
      ]),
    ).toEqual({ side: 'debit', cents: 200 });
    expect(balancingAmount(ok)).toBeNull();
  });

  it('numbers by journal and year', () => {
    expect(formatEntryNumber('VTE', 2026, 42)).toBe('VTE-2026-0042');
  });

  it('finds the fiscal year of a date', () => {
    const years = [
      { id: '25', startDate: '2025-01-01', endDate: '2025-12-31', status: 'CLOSED' as const },
      { id: '26', startDate: '2026-01-01', endDate: '2026-12-31', status: 'OPEN' as const },
    ];
    expect(fiscalYearFor('2025-12-31', years)?.id).toBe('25');
    expect(fiscalYearFor('2026-01-01', years)?.id).toBe('26');
    expect(fiscalYearFor('2027-01-01', years)).toBeNull();
  });

  it('reverses an entry by swapping debit and credit', () => {
    expect(
      reverseLines([
        { debitCents: 5, creditCents: 0 },
        { debitCents: 0, creditCents: 5 },
      ]),
    ).toEqual([
      { debitCents: 0, creditCents: 5 },
      { debitCents: 5, creditCents: 0 },
    ]);
  });

  it('suggests the usual side of a new account', () => {
    expect(
      ['607000', '707000', '401005', '281000', '120000', '512001'].map(defaultNormalSide),
    ).toEqual(['D', 'C', 'M', 'C', 'C', 'D']);
  });
});

describe('automatic entries', () => {
  it('R-CPT-08: a session entry is balanced and follows the account table', () => {
    const lines = buildSessionEntry(
      {
        payments: { CASH: 5200, CHEQUE: 2000, CARD: 1000, WALLET: 1000 },
        revenue: { '707000': 8000, '756000': 1200 },
        topups: { CHEQUE: 2000 },
        cashDifferenceCents: -200,
      },
      A,
    );
    expect(checkEntry(asInput(lines)).balanced).toBe(true);
    const find = (account: string, label: RegExp) =>
      lines.find((l) => l.account === account && label.test(l.label));
    expect(find('531000', /espèces/)).toMatchObject({ debitCents: 5200 });
    expect(find('411000', /cagnotte/)?.debitCents).toBe(1000);
    expect(lines.find((l) => l.account === '707000')).toMatchObject({ creditCents: 8000 });
    expect(lines.find((l) => l.account === '756000')).toMatchObject({ creditCents: 1200 });
    expect(lines.find((l) => l.account === '658000')).toMatchObject({ debitCents: 200 });
    // The cheque top-up debits 511200 and credits the cagnotte 411000.
    expect(
      lines
        .filter((l) => l.account === '511200')
        .map((l) => l.debitCents)
        .sort(),
    ).toEqual([2000, 2000]);
    expect(lines.find((l) => l.account === '411000' && l.creditCents > 0)?.creditCents).toBe(2000);
  });

  it('a cash surplus goes to 758000', () => {
    const lines = buildSessionEntry(
      {
        payments: { CASH: 1000 },
        revenue: { '707000': 1000 },
        topups: {},
        cashDifferenceCents: 150,
      },
      A,
    );
    expect(lines.find((l) => l.account === '758000')).toMatchObject({ creditCents: 150 });
    expect(checkEntry(asInput(lines)).balanced).toBe(true);
  });

  it('a session with nothing to book gives no lines', () => {
    expect(
      buildSessionEntry({ payments: {}, revenue: {}, topups: {}, cashDifferenceCents: 0 }, A),
    ).toEqual([]);
  });

  it('R-FAC-03 / R-FAC-04: invoice then payment', () => {
    const inv = buildInvoiceEntry({
      supplierAccount: '401005',
      expenseLines: [{ account: '607000', cents: 25564 }],
      label: 'Facture F-1',
    });
    expect(inv).toEqual([
      { account: '607000', label: 'Facture F-1', debitCents: 25564, creditCents: 0 },
      { account: '401005', label: 'Facture F-1', debitCents: 0, creditCents: 25564 },
    ]);
    const split = buildInvoiceEntry({
      supplierAccount: '401005',
      expenseLines: [
        { account: '607000', cents: 1000 },
        { account: '606000', cents: 500 },
      ],
      label: 'x',
    });
    expect(split.at(-1)).toMatchObject({ account: '401005', creditCents: 1500 });
    expect(
      buildInvoicePaymentEntry({
        supplierAccount: '401005',
        moneyAccount: '512001',
        cents: 25564,
        label: 'Règlement',
      }),
    ).toEqual([
      { account: '401005', label: 'Règlement', debitCents: 25564, creditCents: 0 },
      { account: '512001', label: 'Règlement', debitCents: 0, creditCents: 25564 },
    ]);
  });

  it('R-CPT-11: a deposit and a bank line, both ways', () => {
    expect(
      buildDepositEntry({
        bankAccount: '512001',
        fromAccount: '531000',
        cents: 5000,
        label: 'Remise',
      })[0],
    ).toMatchObject({ account: '512001', debitCents: 5000 });
    expect(
      buildBankLineEntry({
        bankAccount: '512001',
        counterAccount: '411000',
        amountCents: 3000,
        label: 'x',
      }),
    ).toEqual([
      { account: '512001', label: 'x', debitCents: 3000, creditCents: 0 },
      { account: '411000', label: 'x', debitCents: 0, creditCents: 3000 },
    ]);
    expect(
      buildBankLineEntry({
        bankAccount: '512001',
        counterAccount: '627800',
        amountCents: -450,
        label: 'x',
      })[0],
    ).toMatchObject({ account: '512001', creditCents: 450 });
  });
});

describe('closing (R-CPT-18)', () => {
  const books = [
    bal('707000', 0, 10000),
    bal('607000', 6000, 0),
    bal('512001', 9000, 0),
    bal('101000', 0, 5000),
  ];

  it('computes the result of the year', () => {
    expect(yearResultCents(books)).toBe(4000);
    expect(yearResultCents([bal('707000', 0, 3000), bal('607000', 5000, 0)])).toBe(-2000);
  });

  it('closes the management accounts against 120000 (surplus)', () => {
    const lines = buildResultEntry(books, A);
    expect(lines).toContainEqual({
      account: '707000',
      label: 'Solde du compte de gestion',
      debitCents: 10000,
      creditCents: 0,
    });
    expect(lines).toContainEqual({
      account: '607000',
      label: 'Solde du compte de gestion',
      debitCents: 0,
      creditCents: 6000,
    });
    expect(lines.at(-1)).toMatchObject({ account: '120000', creditCents: 4000 });
    expect(checkEntry(asInput(lines)).balanced).toBe(true);
  });

  it('a deficit goes to 129000', () => {
    const lines = buildResultEntry([bal('707000', 0, 3000), bal('607000', 5000, 0)], A);
    expect(lines.at(-1)).toMatchObject({ account: '129000', debitCents: 2000 });
    expect(checkEntry(asInput(lines)).balanced).toBe(true);
  });

  it('the stock variation brings 370000 to the valued inventory', () => {
    expect(buildStockVariationEntry(1000, 1500, A)).toEqual([
      { account: '370000', label: 'Variation de stock', debitCents: 500, creditCents: 0 },
      { account: '603700', label: 'Variation de stock', debitCents: 0, creditCents: 500 },
    ]);
    expect(buildStockVariationEntry(1000, 700, A)[0]).toMatchObject({
      account: '370000',
      creditCents: 300,
    });
    expect(buildStockVariationEntry(1000, 1000, A)).toEqual([]);
  });

  it('carries forward the balance-sheet accounts only, balanced once the result is allocated', () => {
    const afterAllocation = [
      bal('512001', 9000, 0),
      bal('101000', 0, 5000),
      bal('120000', 0, 4000),
      bal('707000', 0, 0),
    ];
    const lines = buildCarryForwardEntry(afterAllocation);
    expect(lines.map((l) => l.account).sort()).toEqual(['101000', '120000', '512001']);
    expect(checkEntry(asInput(lines)).balanced).toBe(true);
  });
});
