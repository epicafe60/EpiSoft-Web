import { z } from 'zod';
import { amountInput } from './forms';
import { accountClass, balanceOf, type AccountBalance } from './accounting';

// R-CPT-20 — annual budget per expense (6) or income (7) account, compared with the books.
// Amounts are integer cents. Documented default (Q-budget): one yearly amount per account.

export interface BudgetRow {
  number: string;
  label: string;
  budgetCents: number;
  actualCents: number;
  /** Actual − budget: positive is an overspend on expenses, a surplus on income. */
  varianceCents: number;
  /** Actual as a share of the budget, rounded to the unit; null when there is no budget. */
  percent: number | null;
}

export interface BudgetComparison {
  expenses: BudgetRow[];
  income: BudgetRow[];
  budgetExpensesCents: number;
  actualExpensesCents: number;
  budgetIncomeCents: number;
  actualIncomeCents: number;
  /** Budgeted result (income − expenses) and actual one. */
  budgetResultCents: number;
  actualResultCents: number;
}

const nonNegativeAmount = amountInput.refine(
  (s) => !s.startsWith('-'),
  'Le montant ne peut pas être négatif.',
);

/** a/b in percent, half away from zero. */
const percentOf = (a: number, b: number) => Math.sign(a) * Math.round(Math.abs(a * 100) / b);

export const isBudgetAccount = (number: string) => {
  const c = accountClass(number);
  return c === 6 || c === 7;
};

/** Lines for every class 6/7 account that has a budget or movements, sorted by number. */
export function budgetComparison(
  balances: readonly AccountBalance[],
  budgets: readonly { number: string; label: string; budgetCents: number }[],
): BudgetComparison {
  const byNumber = new Map<string, BudgetRow>();
  const row = (number: string, label: string): BudgetRow => {
    let r = byNumber.get(number);
    if (!r) {
      r = { number, label, budgetCents: 0, actualCents: 0, varianceCents: 0, percent: null };
      byNumber.set(number, r);
    }
    return r;
  };
  for (const b of balances) {
    if (!isBudgetAccount(b.number)) continue;
    row(b.number, b.label).actualCents = (accountClass(b.number) === 6 ? 1 : -1) * balanceOf(b);
  }
  for (const b of budgets) {
    if (!isBudgetAccount(b.number)) continue;
    row(b.number, b.label).budgetCents = b.budgetCents;
  }
  const rows = [...byNumber.values()].sort((a, b) => a.number.localeCompare(b.number));
  for (const r of rows) {
    r.varianceCents = r.actualCents - r.budgetCents;
    r.percent = r.budgetCents > 0 ? percentOf(r.actualCents, r.budgetCents) : null;
  }
  const expenses = rows.filter((r) => accountClass(r.number) === 6);
  const income = rows.filter((r) => accountClass(r.number) === 7);
  const sum = (xs: BudgetRow[], k: 'budgetCents' | 'actualCents') =>
    xs.reduce((s, r) => s + r[k], 0);
  return {
    expenses,
    income,
    budgetExpensesCents: sum(expenses, 'budgetCents'),
    actualExpensesCents: sum(expenses, 'actualCents'),
    budgetIncomeCents: sum(income, 'budgetCents'),
    actualIncomeCents: sum(income, 'actualCents'),
    budgetResultCents: sum(income, 'budgetCents') - sum(expenses, 'budgetCents'),
    actualResultCents: sum(income, 'actualCents') - sum(expenses, 'actualCents'),
  };
}

/** Body of the budget editor: every class 6/7 account with its yearly amount (0 removes the line). */
export const budgetSchema = z.object({
  lines: z
    .array(
      z.object({
        number: z.string().regex(/^[67]\d{5}$/, 'Compte de charge ou de produit attendu.'),
        amount: nonNegativeAmount,
      }),
    )
    .max(500),
});

/**
 * Share of the fiscal year elapsed at `today`, in whole percent, clamped to 0..100.
 * Used to read the budget pro rata temporis ("what should be spent by now").
 */
export function elapsedPercent(start: string, end: string, today: string): number {
  const day = 86_400_000;
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  const total = (e - s) / day + 1;
  const done = Math.min(Math.max((t - s) / day + 1, 0), total);
  return Math.round((done / total) * 100);
}

/** Budget share expected by now, in cents (linear over the year). */
export const proRataCents = (budgetCents: number, elapsedPct: number): number =>
  Math.round((budgetCents * elapsedPct) / 100);
