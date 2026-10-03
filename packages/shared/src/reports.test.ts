import { describe, expect, it } from 'vitest';
import type { AccountBalance } from './accounting';
import {
  ageBucket,
  agedPayables,
  balanceSheet,
  buildFec,
  FEC_COLUMNS,
  incomeStatement,
  situation,
} from './reports';

const bal = (number: string, d: number, c: number, label = number): AccountBalance => ({
  number,
  label,
  debitCents: d,
  creditCents: c,
});

describe('income statement (R-CPT-16)', () => {
  const books = [
    bal('707000', 0, 10000),
    bal('754000', 0, 500),
    bal('607000', 6000, 0),
    bal('603700', 0, 200),
    bal('627800', 100, 0),
  ];

  it('groups classes 6 and 7 and gives the result', () => {
    const r = incomeStatement(books);
    expect(r.totalIncomeCents).toBe(10500);
    expect(r.expenses.find((s) => s.code === '60')?.cents).toBe(5800); // 6000 − 200 stock variation
    expect(r.totalExpensesCents).toBe(5900);
    expect(r.resultCents).toBe(4600);
    expect(r.resultAccount).toBe('120000');
  });

  it('a deficit uses 129000', () => {
    const r = incomeStatement([bal('707000', 0, 100), bal('607000', 400, 0)]);
    expect(r.resultCents).toBe(-300);
    expect(r.resultAccount).toBe('129000');
  });
});

describe('balance sheet', () => {
  const books = [
    bal('512001', 9000, 0),
    bal('531000', 300, 0),
    bal('370000', 800, 0),
    bal('411000', 0, 1500), // cagnotte: a liability
    bal('401001', 0, 900),
    bal('101000', 0, 3700),
    bal('707000', 0, 10000),
    bal('607000', 6000, 0),
  ];

  it('both sides agree, with the pending result on the liabilities side', () => {
    const b = balanceSheet(books);
    expect(b.totalAssetsCents).toBe(10100);
    expect(b.pendingResultCents).toBe(4000);
    expect(b.totalLiabilitiesCents).toBe(10100);
    expect(b.liabilities.find((s) => s.code === '41')?.accounts[0]).toMatchObject({
      number: '411000',
      cents: 1500,
    });
  });

  it('a debit balance on 411000 is a receivable', () => {
    const b = balanceSheet([bal('411000', 200, 0), bal('101000', 0, 200)]);
    expect(b.assets.find((s) => s.code === '4')?.cents).toBe(200);
  });

  it('a negative bank balance is a bank debt (liabilities)', () => {
    const b = balanceSheet([bal('512001', 0, 500), bal('101000', 500, 0)]);
    expect(b.liabilities.find((s) => s.code === '5')?.cents).toBe(500);
  });
});

describe('situation intermédiaire (R-CPT-17)', () => {
  it('sales, purchases, stock variation, margin, other income, expenses, result', () => {
    const s = situation([
      bal('707000', 0, 10000),
      bal('607000', 6000, 0),
      bal('603700', 0, 500),
      bal('756000', 0, 1200),
      bal('754000', 0, 300),
      bal('627800', 100, 0),
      bal('616100', 400, 0),
    ]);
    expect(s).toMatchObject({
      salesCents: 10000,
      purchasesCents: 6000,
      stockVariationCents: 500,
      grossMarginCents: 4500,
      marginRatePct: 45,
      otherIncomeCents: 1500,
      expensesCents: 500,
      resultCents: 5500,
    });
  });

  it('no margin rate without sales', () => {
    expect(situation([bal('607000', 100, 0)]).marginRatePct).toBeNull();
  });
});

describe('aged payables', () => {
  it('buckets by days past due', () => {
    expect(ageBucket('2026-10-10', '2026-10-03')).toBe('NOT_DUE');
    expect(ageBucket('2026-10-03', '2026-10-03')).toBe('NOT_DUE');
    expect(ageBucket('2026-09-20', '2026-10-03')).toBe('D0_30');
    expect(ageBucket('2026-08-20', '2026-10-03')).toBe('D31_60');
    expect(ageBucket('2026-07-30', '2026-10-03')).toBe('D61_90');
    expect(ageBucket('2026-01-01', '2026-10-03')).toBe('D90_PLUS');
  });

  it('adds up per supplier', () => {
    const rows = agedPayables(
      [
        { supplierId: 'b', supplierName: 'B', dueDate: '2026-09-20', totalCents: 500 },
        { supplierId: 'a', supplierName: 'A', dueDate: '2026-10-20', totalCents: 1000 },
        { supplierId: 'b', supplierName: 'B', dueDate: '2026-01-01', totalCents: 200 },
      ],
      '2026-10-03',
    );
    expect(rows.map((r) => r.supplierName)).toEqual(['A', 'B']);
    expect(rows[1]).toMatchObject({ totalCents: 700, buckets: { D0_30: 500, D90_PLUS: 200 } });
  });
});

describe('FEC (R-CPT-19)', () => {
  it('has the 18 columns, YYYYMMDD dates and decimal commas', () => {
    const fec = buildFec([
      {
        journalCode: 'ACH',
        journalLabel: 'ACHATS',
        entryNumber: 'ACH-2026-0001',
        date: '2026-02-03',
        account: '401005',
        accountLabel: 'Les Bons Miels',
        pieceRef: 'F-12',
        label: 'Facture\tmiel',
        debitCents: 0,
        creditCents: 25564,
        lettering: 'AA',
        letteredOn: '2026-03-01',
        validatedOn: '2026-04-01',
      },
    ]);
    const [head, row] = fec.split('\r\n');
    expect(head!.split('\t')).toEqual([...FEC_COLUMNS]);
    const cells = row!.split('\t');
    expect(cells).toHaveLength(18);
    expect(cells.slice(3, 7)).toEqual(['20260203', '401005', 'Les Bons Miels', '401005']);
    expect(cells.slice(11, 16)).toEqual(['0,00', '255,64', 'AA', '20260301', '20260401']);
    expect(cells[10]).toBe('Facture miel');
  });
});
