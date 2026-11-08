import { centsToDecimal } from './money';
import type { PaymentMethod } from './pos';

// Accounting rules (spec §4.11). Pure functions on integer cents, shared by the API (source
// of truth) and the entry form (live balance indicator).

export const ACCOUNT_NUMBER_RE = /^\d{6}$/;

export type NormalSide = 'D' | 'C' | 'M';

export function accountClass(number: string): number {
  return Number(number.charAt(0));
}

/** Usual side of a new account, from its number (class 1, 4, 7 and 28/29/39 are credit). */
export function defaultNormalSide(number: string): NormalSide {
  const c = accountClass(number);
  if (c === 4) return 'M';
  if (number.startsWith('28') || number.startsWith('29') || number.startsWith('39')) return 'C';
  return c === 1 || c === 7 ? 'C' : 'D';
}

// --- Entries (R-CPT-04) ---------------------------------------------------------------

export interface EntryLineInput {
  accountId: string | null;
  label: string;
  debitCents: number;
  creditCents: number;
}

export interface EntryCheck {
  debitCents: number;
  creditCents: number;
  diffCents: number;
  balanced: boolean;
  errors: string[];
}

/** R-CPT-04: at least two lines, an account each, debit XOR credit, Σ debit = Σ credit. */
export function checkEntry(lines: readonly EntryLineInput[]): EntryCheck {
  const errors: string[] = [];
  let debitCents = 0;
  let creditCents = 0;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.accountId) errors.push(`Ligne ${n} : compte manquant.`);
    if (l.debitCents < 0 || l.creditCents < 0) errors.push(`Ligne ${n} : montant négatif.`);
    if (l.debitCents > 0 && l.creditCents > 0)
      errors.push(`Ligne ${n} : débit et crédit sur la même ligne.`);
    if (l.debitCents === 0 && l.creditCents === 0) errors.push(`Ligne ${n} : montant nul.`);
    debitCents += l.debitCents;
    creditCents += l.creditCents;
  });
  if (lines.length < 2) errors.push('Une écriture comporte au moins deux lignes.');
  const diffCents = debitCents - creditCents;
  if (diffCents !== 0)
    errors.push(
      `Écriture déséquilibrée : débit ${centsToDecimal(debitCents)} ≠ crédit ${centsToDecimal(creditCents)}.`,
    );
  return { debitCents, creditCents, diffCents, balanced: diffCents === 0, errors };
}

/** R-CPT-07 "solder": the amount and side that balance the entry. */
export function balancingAmount(
  lines: readonly Pick<EntryLineInput, 'debitCents' | 'creditCents'>[],
): { side: 'debit' | 'credit'; cents: number } | null {
  const diff = lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
  if (diff === 0) return null;
  return diff > 0 ? { side: 'credit', cents: diff } : { side: 'debit', cents: -diff };
}

/** VTE-2026-0042 (R-CPT-04). */
export function formatEntryNumber(journalCode: string, year: number, n: number): string {
  return `${journalCode}-${year}-${String(n).padStart(4, '0')}`;
}

export interface FiscalYearLike {
  id: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
}

export function fiscalYearFor<Y extends FiscalYearLike>(
  date: string,
  years: readonly Y[],
): Y | null {
  return years.find((y) => date >= y.startDate && date <= y.endDate) ?? null;
}

/** The counter entry of a validated one (R-CPT-05): debit and credit swapped. */
export function reverseLines<L extends { debitCents: number; creditCents: number }>(
  lines: readonly L[],
): L[] {
  return lines.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents }));
}

// --- Automatic entries (R-CPT-08..11, R-FAC-03/04) -----------------------------------------

export interface AccountMap {
  sales: string;
  purchases: string;
  cash: string;
  cheques: string;
  cards: string;
  bank: string;
  wallet: string;
  memberships: string;
  donations: string;
  otherIncome: string;
  cashShort: string;
  stock: string;
  stockVariation: string;
  surplus: string;
  deficit: string;
}

export const DEFAULT_ACCOUNTS: AccountMap = {
  sales: '707000',
  purchases: '607000',
  cash: '531000',
  cheques: '511200',
  cards: '511300',
  bank: '512001',
  wallet: '411000',
  memberships: '756000',
  donations: '754000',
  otherIncome: '758000',
  cashShort: '658000',
  stock: '370000',
  stockVariation: '603700',
  surplus: '120000',
  deficit: '129000',
};

export interface PlannedLine {
  account: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

const side = (account: string, label: string, signedDebitCents: number): PlannedLine | null =>
  signedDebitCents === 0
    ? null
    : signedDebitCents > 0
      ? { account, label, debitCents: signedDebitCents, creditCents: 0 }
      : { account, label, debitCents: 0, creditCents: -signedDebitCents };

const compact = (lines: (PlannedLine | null)[]): PlannedLine[] =>
  lines.filter((l): l is PlannedLine => l !== null);

export type MoneyMethod = Exclude<PaymentMethod, 'WALLET'>;

function methodAccount(method: PaymentMethod, a: AccountMap): string {
  switch (method) {
    case 'CASH':
      return a.cash;
    case 'CHEQUE':
      return a.cheques;
    case 'CARD':
      return a.cards;
    case 'WALLET':
      return a.wallet;
    case 'TRANSFER':
      return a.bank;
  }
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'espèces',
  CHEQUE: 'chèques',
  CARD: 'cartes',
  WALLET: 'cagnotte',
  TRANSFER: 'virements',
};

export interface SessionAccountingInput {
  /** Net sale payments of the session by method (cancellations subtracted). */
  payments: Partial<Record<PaymentMethod, number>>;
  /** Net revenue by credit account, from the sale lines (R-CPT-08 table). */
  revenue: Record<string, number>;
  /** Cagnotte top-ups received at the till, by method. */
  topups: Partial<Record<MoneyMethod, number>>;
  /** counted − expected cash (R-SES-02). */
  cashDifferenceCents: number;
}

/**
 * R-CPT-08: the VTE draft entry of a cash session.
 * Debits: money received by method (cagnotte payments debit 411000). Credits: revenue by
 * account (707 goods, 756 memberships, 754 donations) and top-ups (411000). A cash
 * difference goes to 658000 (shortage) or 758000 (surplus).
 */
export function buildSessionEntry(input: SessionAccountingInput, a: AccountMap): PlannedLine[] {
  const lines: (PlannedLine | null)[] = [];
  for (const m of ['CASH', 'CHEQUE', 'CARD', 'WALLET', 'TRANSFER'] as const) {
    lines.push(side(methodAccount(m, a), `Ventes ${METHOD_LABEL[m]}`, input.payments[m] ?? 0));
  }
  for (const [account, cents] of Object.entries(input.revenue).sort(([x], [y]) =>
    x.localeCompare(y),
  )) {
    lines.push(side(account, revenueLabel(account, a), -cents));
  }
  for (const m of ['CASH', 'CHEQUE', 'CARD', 'TRANSFER'] as const) {
    const t = input.topups[m] ?? 0;
    lines.push(side(methodAccount(m, a), `Versements cagnotte ${METHOD_LABEL[m]}`, t));
    lines.push(side(a.wallet, `Versements cagnotte ${METHOD_LABEL[m]}`, -t));
  }
  const d = input.cashDifferenceCents;
  if (d < 0) {
    lines.push(side(a.cashShort, 'Écart de caisse (manquant)', -d));
    lines.push(side(a.cash, 'Écart de caisse (manquant)', d));
  } else if (d > 0) {
    lines.push(side(a.cash, 'Écart de caisse (excédent)', d));
    lines.push(side(a.otherIncome, 'Écart de caisse (excédent)', -d));
  }
  return mergeSameLines(compact(lines));
}

function revenueLabel(account: string, a: AccountMap): string {
  if (account === a.memberships) return 'Adhésions';
  if (account === a.donations) return 'Dons';
  if (account === a.sales) return 'Ventes de marchandises';
  return `Ventes (compte ${account})`;
}

/** Same account, same side and same label: one line (top-ups of the same method). */
function mergeSameLines(lines: PlannedLine[]): PlannedLine[] {
  const out: PlannedLine[] = [];
  for (const l of lines) {
    const prev = out.find(
      (o) =>
        o.account === l.account && o.label === l.label && o.debitCents > 0 === l.debitCents > 0,
    );
    if (prev) {
      prev.debitCents += l.debitCents;
      prev.creditCents += l.creditCents;
    } else out.push({ ...l });
  }
  return out;
}

/** R-FAC-03: ACH draft. The association is presumed not liable to VAT (Q1): TTC is the cost. */
/**
 * Audit KV2, C02: what is missing from the accounts of a closed session once tickets arrived after
 * its entry was validated (a validated entry is never changed, R-CPT-05). `recorded` are the lines
 * already written for the session, `expected` what the entry would be today: the result moves each
 * account by the difference, debit or credit. Balanced whenever both sides are.
 */
export function regularizationLines(
  recorded: readonly { account: string; debitCents: number; creditCents: number }[],
  expected: readonly PlannedLine[],
  label: string,
): PlannedLine[] {
  const net = new Map<string, number>();
  for (const l of expected)
    net.set(l.account, (net.get(l.account) ?? 0) + l.debitCents - l.creditCents);
  for (const l of recorded)
    net.set(l.account, (net.get(l.account) ?? 0) - (l.debitCents - l.creditCents));
  const out: PlannedLine[] = [];
  for (const [account, cents] of [...net.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (cents === 0) continue;
    out.push(
      cents > 0
        ? { account, label, debitCents: cents, creditCents: 0 }
        : { account, label, debitCents: 0, creditCents: -cents },
    );
  }
  return out;
}

export function buildInvoiceEntry(a: {
  supplierAccount: string;
  expenseLines: { account: string; cents: number }[];
  label: string;
}): PlannedLine[] {
  const total = a.expenseLines.reduce((s, l) => s + l.cents, 0);
  return compact([
    ...a.expenseLines.map((l) => side(l.account, a.label, l.cents)),
    side(a.supplierAccount, a.label, -total),
  ]);
}

/** R-FAC-04: payment of an invoice: 401 debited, bank (512) or cash (531) credited. */
export function buildInvoicePaymentEntry(a: {
  supplierAccount: string;
  moneyAccount: string;
  cents: number;
  label: string;
}): PlannedLine[] {
  return compact([
    side(a.supplierAccount, a.label, a.cents),
    side(a.moneyAccount, a.label, -a.cents),
  ]);
}

/** R-CPT-11: deposit at the bank: 512 debited, 531 / 511200 / 511300 credited. */
export function buildDepositEntry(a: {
  bankAccount: string;
  fromAccount: string;
  cents: number;
  label: string;
}): PlannedLine[] {
  return compact([side(a.bankAccount, a.label, a.cents), side(a.fromAccount, a.label, -a.cents)]);
}

/** Entry for a bank line: money in debits the bank account, money out credits it. */
export function buildBankLineEntry(a: {
  bankAccount: string;
  counterAccount: string;
  amountCents: number;
  label: string;
}): PlannedLine[] {
  return compact([
    side(a.bankAccount, a.label, a.amountCents),
    side(a.counterAccount, a.label, -a.amountCents),
  ]);
}

// --- Closing (R-CPT-18) --------------------------------------------------------------------

export interface AccountBalance {
  number: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

export const balanceOf = (b: Pick<AccountBalance, 'debitCents' | 'creditCents'>) =>
  b.debitCents - b.creditCents;

/** Result of the year: income (class 7) minus expenses (class 6), in cents. */
export function yearResultCents(balances: readonly AccountBalance[]): number {
  return balances.reduce((s, b) => {
    const c = accountClass(b.number);
    return c === 7 ? s - balanceOf(b) : c === 6 ? s - balanceOf(b) : s;
  }, 0);
}

/**
 * Closing entry: zeroes every class 6 and 7 account against 120000 (surplus) or 129000
 * (deficit). Returns no line when there is nothing to close.
 */
export function buildResultEntry(
  balances: readonly AccountBalance[],
  a: AccountMap,
): PlannedLine[] {
  const lines: (PlannedLine | null)[] = [];
  for (const b of balances) {
    const c = accountClass(b.number);
    if (c !== 6 && c !== 7) continue;
    lines.push(side(b.number, 'Solde du compte de gestion', -balanceOf(b)));
  }
  const result = yearResultCents(balances);
  lines.push(
    result >= 0
      ? side(a.surplus, 'Résultat de l’exercice (excédent)', -result)
      : side(a.deficit, 'Résultat de l’exercice (déficit)', -result),
  );
  return compact(lines);
}

/** Stock variation (R-CPT-18 step 2): brings account 370000 to the valued inventory. */
export function buildStockVariationEntry(
  currentStockCents: number,
  targetCents: number,
  a: AccountMap,
): PlannedLine[] {
  const delta = targetCents - currentStockCents;
  return compact([
    side(a.stock, 'Variation de stock', delta),
    side(a.stockVariation, 'Variation de stock', -delta),
  ]);
}

/**
 * À-nouveaux: every balance-sheet account (classes 1 to 5) with a balance, carried to the
 * first day of the next year. Balanced as long as the result has been allocated first.
 */
export function buildCarryForwardEntry(balances: readonly AccountBalance[]): PlannedLine[] {
  return compact(
    balances
      .filter((b) => accountClass(b.number) <= 5)
      .map((b) => side(b.number, 'Report à nouveau', balanceOf(b))),
  );
}
