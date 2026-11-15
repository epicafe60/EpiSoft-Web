import { centsToDecimal, decimalToCents } from './money';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from './pos';

// The operations of a session (or of a day) at the till: one row per ticket and one per payment made
// outside a ticket (a top-up of the cagnotte, a membership or a donation paid on its own), with what
// each one holds of donation, membership and cagnotte movement. Pure rules: the server writes the
// rows from the database, the till from its own queue, and both add them up the same way.

/** R-EVO-08: the service product of the donations (account 754 at closing). */
export const DONATION_PRODUCT_CODE = '01004';

export const OPERATION_TYPES = [
  'SALE',
  'TOPUP',
  'MEMBERSHIP_PAYMENT',
  'DONATION_PAYMENT',
  'OTHER_PAYMENT',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_TYPE_LABELS: Record<OperationType, string> = {
  SALE: 'Vente',
  TOPUP: 'Rechargement de cagnotte',
  MEMBERSHIP_PAYMENT: 'Versement adhésion',
  DONATION_PAYMENT: 'Versement don',
  OTHER_PAYMENT: 'Autre versement',
};

/** The type of a payment made outside a ticket, from its purpose. */
export function operationTypeOfPurpose(
  purpose: 'MEMBERSHIP' | 'TOPUP' | 'DONATION' | 'OTHER',
): Exclude<OperationType, 'SALE'> {
  return purpose === 'TOPUP'
    ? 'TOPUP'
    : purpose === 'MEMBERSHIP'
      ? 'MEMBERSHIP_PAYMENT'
      : purpose === 'DONATION'
        ? 'DONATION_PAYMENT'
        : 'OTHER_PAYMENT';
}

export interface OperationRow {
  id: string;
  /** Where the row was read: the till's own queue, or the server. */
  origin: 'LOCAL' | 'SERVER';
  type: OperationType;
  /** ISO date and time. */
  at: string;
  /** Number of the ticket (the provisional one until the server gives the final one). */
  number: string | null;
  cashierName: string | null;
  /** The till that made it, when it is not this one. */
  deviceName: string | null;
  memberName: string | null;
  payments: { method: PaymentMethod; amount: string }[];
  /** The ticket total, or the amount of the payment. */
  total: string;
  /** What the ticket holds of donations and of memberships (service lines). */
  donation: string;
  membership: string;
  /** Signed: a top-up adds to the cagnotte, a payment from the cagnotte takes from it. */
  wallet: string;
  /** Cash taken for the change paid into the cagnotte (it is in the drawer, not in the payments). */
  walletCash: string;
  /** Cancelled: shown struck through and left out of every total. */
  cancelled: boolean;
  /** For a ticket made at this till: not sent yet, sent, or refused by the server. */
  sync: 'SENT' | 'PENDING' | 'REJECTED';
  error: string | null;
}

// --- What a ticket holds ------------------------------------------------------------------------

export interface SaleAmountsInput {
  lines: readonly { productId: string; totalCents: number }[];
  payments: readonly {
    method: PaymentMethod;
    amountCents: number;
    changeCents?: number | null;
    changeToWallet?: boolean | null;
  }[];
  donationProductIds: ReadonlySet<string>;
  membershipProductIds: ReadonlySet<string>;
}

/**
 * The donation, the membership and the cagnotte movement of a ticket (all in cents). The cagnotte
 * loses what was paid from it and gains the change that was paid into it (R-CAG-05).
 */
export function saleOperationAmounts(i: SaleAmountsInput): {
  donationCents: number;
  membershipCents: number;
  walletCents: number;
  walletCashCents: number;
} {
  const sum = (ids: ReadonlySet<string>) =>
    i.lines.filter((l) => ids.has(l.productId)).reduce((s, l) => s + l.totalCents, 0);
  const paid = i.payments
    .filter((p) => p.method === 'WALLET')
    .reduce((s, p) => s + p.amountCents, 0);
  const changed = i.payments
    .filter((p) => p.changeToWallet && (p.changeCents ?? 0) > 0)
    .reduce((s, p) => s + p.changeCents!, 0);
  return {
    donationCents: sum(i.donationProductIds),
    membershipCents: sum(i.membershipProductIds),
    walletCents: changed - paid,
    walletCashCents: changed,
  };
}

// --- Adding up ----------------------------------------------------------------------------------

export interface OperationTotals {
  /** Operations counted (the cancelled ones are not). */
  count: number;
  /** What came in, by way of payment: a ticket's payments, a payment's amount, the cash of the change. */
  byMethod: Record<PaymentMethod, string>;
  /** The tickets, and the payments made outside a ticket. */
  sales: string;
  payments: string;
  donation: string;
  membership: string;
  /** Net movement of the cagnotte. */
  wallet: string;
}

export function operationTotals(rows: readonly OperationRow[]): OperationTotals {
  const live = rows.filter((r) => !r.cancelled);
  const by = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<
    PaymentMethod,
    number
  >;
  let sales = 0;
  let payments = 0;
  let donation = 0;
  let membership = 0;
  let wallet = 0;
  for (const r of live) {
    for (const p of r.payments) by[p.method] += decimalToCents(p.amount);
    by.CASH += decimalToCents(r.walletCash);
    if (r.type === 'SALE') sales += decimalToCents(r.total);
    else payments += decimalToCents(r.total);
    donation += decimalToCents(r.donation);
    membership += decimalToCents(r.membership);
    wallet += decimalToCents(r.wallet);
  }
  return {
    count: live.length,
    byMethod: Object.fromEntries(PAYMENT_METHODS.map((m) => [m, centsToDecimal(by[m])])) as Record<
      PaymentMethod,
      string
    >,
    sales: centsToDecimal(sales),
    payments: centsToDecimal(payments),
    donation: centsToDecimal(donation),
    membership: centsToDecimal(membership),
    wallet: centsToDecimal(wallet),
  };
}

// --- Filtering ----------------------------------------------------------------------------------

export interface OperationFilter {
  type?: OperationType | '';
  cashier?: string;
  method?: PaymentMethod | '';
  /** Looked for in the number, the member, the cashier. */
  q?: string;
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filterOperations(
  rows: readonly OperationRow[],
  f: OperationFilter,
): OperationRow[] {
  const q = f.q ? plain(f.q.trim()) : '';
  return rows.filter((r) => {
    if (f.type && r.type !== f.type) return false;
    if (f.cashier && r.cashierName !== f.cashier) return false;
    if (f.method && !r.payments.some((p) => p.method === f.method)) return false;
    if (q && !plain([r.number, r.memberName, r.cashierName].filter(Boolean).join(' ')).includes(q))
      return false;
    return true;
  });
}

/** « Espèces 10,00 · Cagnotte 6,90 »: the payments of a row, for a cell. */
export function paymentsLabel(
  payments: OperationRow['payments'],
  format: (amount: string) => string,
): string {
  return payments.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${format(p.amount)}`).join(' · ');
}

/** The rows, the most recent first. */
export const sortOperations = (rows: readonly OperationRow[]): OperationRow[] =>
  [...rows].sort((a, b) => b.at.localeCompare(a.at));
