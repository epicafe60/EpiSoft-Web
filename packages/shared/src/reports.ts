import {
  accountClass,
  balanceOf,
  DEFAULT_ACCOUNTS,
  type AccountBalance,
  type AccountMap,
} from './accounting';
import { addDays } from './pos';

// Accounting reports (spec §4.11 R-CPT-16/17), computed from account balances.
// All amounts are integer cents. Presentation follows the simplified associative layout.

export interface Section {
  code: string;
  label: string;
  accounts: { number: string; label: string; cents: number }[];
  cents: number;
}

function sectionsOf(
  balances: readonly AccountBalance[],
  defs: readonly { code: string; label: string; prefixes: readonly string[] }[],
  sign: 1 | -1,
): Section[] {
  return defs
    .map((d) => {
      const accounts = balances
        .filter((b) => d.prefixes.some((p) => b.number.startsWith(p)))
        .map((b) => ({ number: b.number, label: b.label, cents: sign * balanceOf(b) }))
        .filter((a) => a.cents !== 0)
        .sort((x, y) => x.number.localeCompare(y.number));
      return {
        code: d.code,
        label: d.label,
        accounts,
        cents: accounts.reduce((s, a) => s + a.cents, 0),
      };
    })
    .filter((s) => s.accounts.length > 0);
}

const EXPENSE_SECTIONS = [
  { code: '60', label: 'Achats et variation de stock', prefixes: ['60'] },
  { code: '61', label: 'Services extérieurs', prefixes: ['61'] },
  { code: '62', label: 'Autres services extérieurs', prefixes: ['62'] },
  { code: '63', label: 'Impôts et taxes', prefixes: ['63'] },
  { code: '64', label: 'Charges de personnel', prefixes: ['64'] },
  { code: '65', label: 'Autres charges de gestion', prefixes: ['65'] },
  { code: '66', label: 'Charges financières', prefixes: ['66'] },
  { code: '67', label: 'Charges exceptionnelles', prefixes: ['67'] },
  { code: '68', label: 'Dotations aux amortissements', prefixes: ['68'] },
] as const;

const INCOME_SECTIONS = [
  { code: '70', label: 'Ventes', prefixes: ['70'] },
  { code: '74', label: 'Subventions', prefixes: ['74'] },
  { code: '75', label: 'Cotisations, dons et autres produits', prefixes: ['75'] },
  { code: '76', label: 'Produits financiers', prefixes: ['76'] },
  { code: '77', label: 'Produits exceptionnels', prefixes: ['77'] },
  { code: '78', label: 'Reprises', prefixes: ['78'] },
] as const;

export interface IncomeStatement {
  expenses: Section[];
  income: Section[];
  totalExpensesCents: number;
  totalIncomeCents: number;
  /** income − expenses; positive: surplus (120000), negative: deficit (129000). */
  resultCents: number;
  resultAccount: string;
}

/** Compte de résultat (R-CPT-16): classes 6 and 7, with the result line. */
export function incomeStatement(
  balances: readonly AccountBalance[],
  accounts: AccountMap = DEFAULT_ACCOUNTS,
): IncomeStatement {
  const expenses = sectionsOf(balances, EXPENSE_SECTIONS, 1);
  const income = sectionsOf(balances, INCOME_SECTIONS, -1);
  const totalExpensesCents = expenses.reduce((s, x) => s + x.cents, 0);
  const totalIncomeCents = income.reduce((s, x) => s + x.cents, 0);
  const resultCents = totalIncomeCents - totalExpensesCents;
  return {
    expenses,
    income,
    totalExpensesCents,
    totalIncomeCents,
    resultCents,
    resultAccount: resultCents >= 0 ? accounts.surplus : accounts.deficit,
  };
}

export interface BalanceSheet {
  assets: Section[];
  liabilities: Section[];
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  /** Result of the year not yet allocated (classes 6 and 7), shown on the liabilities side. */
  pendingResultCents: number;
}

/**
 * Bilan simplifié. Classes 2 and 3 are assets (28/29/39 net against them), class 1 is
 * liabilities; classes 4 and 5 go to the side of their balance (a credit balance on 411000 is
 * the members' cagnotte, a liability). The year's result is added to the liabilities until it
 * is allocated, so the two sides always agree.
 */
export function balanceSheet(balances: readonly AccountBalance[]): BalanceSheet {
  const bs = balances.filter((b) => accountClass(b.number) <= 5);
  const debitSide = (b: AccountBalance) =>
    accountClass(b.number) === 4 || accountClass(b.number) === 5
      ? balanceOf(b) > 0
      : accountClass(b.number) >= 2;
  const assetsList = bs.filter(debitSide);
  const liabilitiesList = bs.filter((b) => !debitSide(b));
  const assets = sectionsOf(
    assetsList,
    [
      { code: '2', label: 'Immobilisations', prefixes: ['2'] },
      { code: '3', label: 'Stocks', prefixes: ['3'] },
      { code: '4', label: 'Créances', prefixes: ['4'] },
      { code: '5', label: 'Trésorerie', prefixes: ['5'] },
    ],
    1,
  );
  const liabilities = sectionsOf(
    liabilitiesList,
    [
      { code: '10', label: 'Fonds propres et reports', prefixes: ['10', '11', '12'] },
      { code: '13', label: 'Subventions d’investissement', prefixes: ['13'] },
      { code: '40', label: 'Fournisseurs', prefixes: ['40'] },
      {
        code: '41',
        label: 'Cagnottes des adhérents et autres dettes',
        prefixes: ['41', '42', '43', '44', '45', '46', '47', '48'],
      },
      { code: '5', label: 'Dettes bancaires', prefixes: ['5'] },
      { code: '89', label: 'Bilan d’ouverture', prefixes: ['89'] },
    ],
    -1,
  );
  const pendingResultCents = -balances
    .filter((b) => accountClass(b.number) >= 6)
    .reduce((s, b) => s + balanceOf(b), 0);
  const totalAssetsCents = assets.reduce((s, x) => s + x.cents, 0);
  const totalLiabilitiesCents = liabilities.reduce((s, x) => s + x.cents, 0) + pendingResultCents;
  return { assets, liabilities, totalAssetsCents, totalLiabilitiesCents, pendingResultCents };
}

export interface Situation {
  salesCents: number;
  purchasesCents: number;
  stockVariationCents: number;
  grossMarginCents: number;
  /** margin / sales, in % with 2 decimals; null without sales. */
  marginRatePct: number | null;
  otherIncomeCents: number;
  expensesCents: number;
  resultCents: number;
}

/**
 * R-CPT-17 situation intermédiaire: sales, purchases, stock variation, margin, other income
 * (74–77), expenses (61–68) and result. Account 603700 is credited when the stock increases.
 */
export function situation(
  balances: readonly AccountBalance[],
  accounts: AccountMap = DEFAULT_ACCOUNTS,
): Situation {
  const cents = (pred: (n: string) => boolean, sign: 1 | -1) =>
    balances.filter((b) => pred(b.number)).reduce((s, b) => s + sign * balanceOf(b), 0);
  const salesCents = cents((n) => n.startsWith('70'), -1);
  const stockVariationCents = -cents((n) => n === accounts.stockVariation, 1);
  const purchasesCents = cents((n) => n.startsWith('60') && n !== accounts.stockVariation, 1);
  const grossMarginCents = salesCents - purchasesCents + stockVariationCents;
  const otherIncomeCents = cents((n) => /^7[4-9]/.test(n), -1);
  const expensesCents = cents((n) => /^6[1-8]/.test(n), 1);
  return {
    salesCents,
    purchasesCents,
    stockVariationCents,
    grossMarginCents,
    marginRatePct:
      salesCents > 0 ? Math.round((grossMarginCents / salesCents) * 10_000) / 100 : null,
    otherIncomeCents,
    expensesCents,
    resultCents: grossMarginCents + otherIncomeCents - expensesCents,
  };
}

// --- Aged payables (R-CPT-16) ---------------------------------------------------------------

export const AGE_BUCKETS = ['NOT_DUE', 'D0_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];
export const AGE_BUCKET_LABELS: Record<AgeBucket, string> = {
  NOT_DUE: 'Non échu',
  D0_30: '0 à 30 jours',
  D31_60: '31 à 60 jours',
  D61_90: '61 à 90 jours',
  D90_PLUS: 'Plus de 90 jours',
};

export function ageBucket(dueDate: string, today: string): AgeBucket {
  if (dueDate >= today) return 'NOT_DUE';
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000,
  );
  return days <= 30 ? 'D0_30' : days <= 60 ? 'D31_60' : days <= 90 ? 'D61_90' : 'D90_PLUS';
}

export interface PayableInput {
  supplierId: string;
  supplierName: string;
  dueDate: string;
  totalCents: number;
}

export interface AgedRow {
  supplierId: string;
  supplierName: string;
  buckets: Record<AgeBucket, number>;
  totalCents: number;
}

export function agedPayables(invoices: readonly PayableInput[], today: string): AgedRow[] {
  const rows = new Map<string, AgedRow>();
  for (const i of invoices) {
    const row = rows.get(i.supplierId) ?? {
      supplierId: i.supplierId,
      supplierName: i.supplierName,
      buckets: { NOT_DUE: 0, D0_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0 },
      totalCents: 0,
    };
    row.buckets[ageBucket(i.dueDate, today)] += i.totalCents;
    row.totalCents += i.totalCents;
    rows.set(i.supplierId, row);
  }
  return [...rows.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName));
}

// --- FEC (R-CPT-19) ----------------------------------------------------------------------------

export const FEC_COLUMNS = [
  'JournalCode',
  'JournalLib',
  'EcritureNum',
  'EcritureDate',
  'CompteNum',
  'CompteLib',
  'CompAuxNum',
  'CompAuxLib',
  'PieceRef',
  'PieceDate',
  'EcritureLib',
  'Debit',
  'Credit',
  'EcritureLet',
  'DateLet',
  'ValidDate',
  'Montantdevise',
  'Idevise',
] as const;

export interface FecLine {
  journalCode: string;
  journalLabel: string;
  entryNumber: string;
  date: string;
  account: string;
  accountLabel: string;
  pieceRef: string | null;
  label: string;
  debitCents: number;
  creditCents: number;
  lettering: string | null;
  letteredOn: string | null;
  validatedOn: string;
}

const fecDate = (d: string) => d.replaceAll('-', '');
const fecAmount = (c: number) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`;
const clean = (s: string) => s.replace(/[\t\r\n|]/g, ' ').trim();

/**
 * FEC: tab-separated, one header line, dates as YYYYMMDD, decimal comma. Only validated
 * entries belong in it. Supplier (401) and member (411) accounts are given as auxiliary.
 */
export function buildFec(lines: readonly FecLine[]): string {
  const rows = lines.map((l) => {
    const aux = l.account.startsWith('401') || l.account.startsWith('411');
    return [
      l.journalCode,
      clean(l.journalLabel),
      l.entryNumber,
      fecDate(l.date),
      l.account,
      clean(l.accountLabel),
      aux ? l.account : '',
      aux ? clean(l.accountLabel) : '',
      clean(l.pieceRef ?? l.entryNumber),
      fecDate(l.date),
      clean(l.label),
      fecAmount(l.debitCents),
      fecAmount(l.creditCents),
      l.lettering ?? '',
      l.letteredOn ? fecDate(l.letteredOn) : '',
      fecDate(l.validatedOn),
      '',
      '',
    ].join('\t');
  });
  return [FEC_COLUMNS.join('\t'), ...rows].join('\r\n') + '\r\n';
}

/** First day of the fiscal year after `endDate`. */
export const nextYearStart = (endDate: string) => addDays(endDate, 1);
