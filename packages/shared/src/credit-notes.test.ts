import { describe, expect, it } from 'vitest';
import { buildInvoiceEntry, checkEntry } from './accounting';
import { cashPaymentProblem, CASH_PAYMENT_LIMIT_CENTS } from './cash-limit';
import {
  buildCreditNoteEntry,
  creditNoteApplySchema,
  creditNoteSchema,
  creditNoteTooLargeProblem,
  fiscalYearReopenSchema,
} from './credit-notes';
import {
  decimalToMicro,
  microToDecimal,
  nextAverage,
  valueAtAverageCents,
  type AverageState,
} from './stock-cost';

describe('credit notes', () => {
  it('refuses a credit note larger than what is left of its invoice', () => {
    const ok = { invoiceCents: 10000, alreadyCreditedCents: 0 };
    expect(creditNoteTooLargeProblem({ ...ok, creditCents: 3000 })).toBeNull();
    expect(creditNoteTooLargeProblem({ ...ok, creditCents: 10000 })).toBeNull();
    expect(
      creditNoteTooLargeProblem({
        creditCents: 8000,
        invoiceCents: 10000,
        alreadyCreditedCents: 3000,
      }),
    ).toContain('dépasse');
    expect(
      creditNoteTooLargeProblem({
        creditCents: 1,
        invoiceCents: 10000,
        alreadyCreditedCents: 10000,
      }),
    ).toContain('entièrement');
  });

  it('books the opposite of the invoice entry, balanced', () => {
    const credit = buildCreditNoteEntry({
      supplierAccount: '401005',
      expenseAccount: '607000',
      cents: 3000,
      label: 'Avoir',
    });
    const invoice = buildInvoiceEntry({
      supplierAccount: '401005',
      expenseLines: [{ account: '607000', cents: 3000 }],
      label: 'Avoir',
    });
    expect(credit).toEqual(
      invoice.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents })),
    );
    expect(credit.find((l) => l.account === '401005')).toMatchObject({
      debitCents: 3000,
      creditCents: 0,
    });
    const check = checkEntry(
      credit.map((l, i) => ({
        accountId: `a${i}`,
        label: l.label,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      })),
    );
    expect(check.balanced).toBe(true);
  });

  it('requires positive amounts and a motif of at least 5 characters', () => {
    const form = {
      supplierId: '0190a0a0-0000-7000-8000-000000000001',
      pieceRef: 'AV-1',
      date: '2026-03-01',
      totalExcl: '10',
      totalVat: '0',
      totalIncl: '10',
    };
    expect(creditNoteSchema.safeParse(form).success).toBe(true);
    expect(creditNoteSchema.safeParse({ ...form, totalIncl: '-10' }).success).toBe(false);
    expect(creditNoteSchema.safeParse({ ...form, totalIncl: '0' }).success).toBe(false);
    expect(
      creditNoteApplySchema.safeParse({
        invoiceId: form.supplierId,
        amount: '0',
        date: '2026-03-01',
      }).success,
    ).toBe(false);
    expect(fiscalYearReopenSchema.safeParse({ reason: 'ab' }).success).toBe(false);
    expect(fiscalYearReopenSchema.safeParse({ reason: 'stock mal compté' }).success).toBe(true);
  });
});

describe('payments in cash (art. L112-6, D112-3 CMF)', () => {
  it('accepts up to 1 000 euros and refuses above, quoting the law', () => {
    expect(CASH_PAYMENT_LIMIT_CENTS).toBe(100_000);
    expect(cashPaymentProblem(100_000)).toBeNull();
    expect(cashPaymentProblem(100_001)).toContain('D112-3');
  });
});

describe('weighted average cost (CMUP, R-STK-06)', () => {
  const buy = (s: AverageState, qtyMilli: number, cost: number): AverageState => ({
    qtyMilli: s.qtyMilli + qtyMilli,
    avgMicro: nextAverage(s, {
      qtyMilli,
      unitCostMicro: decimalToMicro(String(cost)),
      priced: true,
    }),
  });
  const out = (s: AverageState, qtyMilli: number): AverageState => ({
    qtyMilli: s.qtyMilli - qtyMilli,
    avgMicro: nextAverage(s, { qtyMilli: -qtyMilli, unitCostMicro: null, priced: false }),
  });

  it('weights receipts at different prices and leaves sales and losses at the average', () => {
    let s: AverageState = { qtyMilli: 0, avgMicro: null };
    s = buy(s, 10_000, 5); // 10 at 5
    s = buy(s, 10_000, 7); // 10 at 7: average 6
    expect(microToDecimal(s.avgMicro!)).toBe('6.000000');
    s = out(s, 5_000); // sale
    s = out(s, 3_000); // loss
    expect(s).toEqual({ qtyMilli: 12_000, avgMicro: 6_000_000 });
    expect(valueAtAverageCents(s.qtyMilli, s.avgMicro)).toBe(7200);
    s = buy(s, 8_000, 9); // (12 x 6 + 8 x 9) / 20 = 7.2
    expect(microToDecimal(s.avgMicro!)).toBe('7.200000');
    expect(valueAtAverageCents(s.qtyMilli, s.avgMicro)).toBe(14400);
  });

  it('restarts from the receipt cost when the stock was empty or negative', () => {
    expect(buy({ qtyMilli: -2_000, avgMicro: 4_000_000 }, 5_000, 3).avgMicro).toBe(3_000_000);
    expect(buy({ qtyMilli: 0, avgMicro: 4_000_000 }, 5_000, 3).avgMicro).toBe(3_000_000);
  });

  it('does not let an inventory gain change the average, and adopts a first known cost', () => {
    const gain = nextAverage(
      { qtyMilli: 4_000, avgMicro: 2_500_000 },
      { qtyMilli: 1_000, unitCostMicro: 9_000_000, priced: false },
    );
    expect(gain).toBe(2_500_000);
    const first = nextAverage(
      { qtyMilli: 0, avgMicro: null },
      { qtyMilli: 1_000, unitCostMicro: 1_200_000, priced: false },
    );
    expect(first).toBe(1_200_000);
  });

  it('keeps cents exact on awkward averages', () => {
    let s: AverageState = { qtyMilli: 0, avgMicro: null };
    s = buy(s, 3_000, 1);
    s = buy(s, 4_000, 2); // 11 / 7 = 1.571429
    expect(microToDecimal(s.avgMicro!)).toBe('1.571429');
    expect(valueAtAverageCents(s.qtyMilli, s.avgMicro)).toBe(1100);
  });
});
