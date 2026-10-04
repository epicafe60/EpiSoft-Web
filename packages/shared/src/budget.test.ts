import { describe, expect, it } from 'vitest';
import { budgetComparison } from './budget';

const bal = (number: string, debitCents: number, creditCents: number) => ({
  number,
  label: `Compte ${number}`,
  debitCents,
  creditCents,
});

describe('R-CPT-20 budget comparison', () => {
  const r = budgetComparison(
    [
      bal('607000', 80_000, 5_000), // net expense 750.00
      bal('707000', 0, 120_000), // income 1200.00
      bal('512000', 999, 0), // not a budget account: ignored
    ],
    [
      { number: '607000', label: 'Achats', budgetCents: 100_000 },
      { number: '707000', label: 'Ventes', budgetCents: 100_000 },
      { number: '613000', label: 'Locations', budgetCents: 30_000 }, // budgeted, nothing booked
      { number: '411000', label: 'ignoré', budgetCents: 5 },
    ],
  );
  it('signs actuals by class and reports variances', () => {
    expect(r.expenses.map((x) => [x.number, x.actualCents, x.varianceCents, x.percent])).toEqual([
      ['607000', 75_000, -25_000, 75],
      ['613000', 0, -30_000, 0],
    ]);
    expect(r.income[0]).toMatchObject({
      actualCents: 120_000,
      varianceCents: 20_000,
      percent: 120,
    });
  });
  it('totals and results, leaving other classes out', () => {
    expect(r.budgetExpensesCents).toBe(130_000);
    expect(r.actualExpensesCents).toBe(75_000);
    expect(r.budgetResultCents).toBe(-30_000);
    expect(r.actualResultCents).toBe(45_000);
    expect(r.expenses.concat(r.income)).toHaveLength(3);
  });
  it('has no percentage without a budget', () => {
    const x = budgetComparison([bal('606000', 500, 0)], []);
    expect(x.expenses[0]).toMatchObject({ budgetCents: 0, actualCents: 500, percent: null });
  });
});

describe('budgetSchema', () => {
  it('accepts comma amounts on class 6/7 accounts only', async () => {
    const { budgetSchema } = await import('./budget');
    const ok = budgetSchema.safeParse({ lines: [{ number: '607000', amount: '1 200,5' }] });
    expect(ok.success && ok.data.lines[0]!.amount).toBe('1200.50');
    expect(budgetSchema.safeParse({ lines: [{ number: '512000', amount: '1' }] }).success).toBe(
      false,
    );
    expect(budgetSchema.safeParse({ lines: [{ number: '607000', amount: '-1' }] }).success).toBe(
      false,
    );
  });
});

describe('pro rata', () => {
  it('measures the elapsed share of a fiscal year', async () => {
    const { elapsedPercent, proRataCents } = await import('./budget');
    expect(elapsedPercent('2026-01-01', '2026-12-31', '2025-12-31')).toBe(0);
    expect(elapsedPercent('2026-01-01', '2026-12-31', '2026-07-02')).toBe(50);
    expect(elapsedPercent('2026-01-01', '2026-12-31', '2026-12-31')).toBe(100);
    expect(elapsedPercent('2026-01-01', '2026-12-31', '2027-03-01')).toBe(100);
    expect(proRataCents(120_000, 25)).toBe(30_000);
  });
});
