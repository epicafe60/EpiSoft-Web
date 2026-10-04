import { normalizeSearch } from './text';

// Till rules (spec §4.4, §4.5). Money is handled in integer cents and quantities in
// integer thousandths ("milli"), so client (offline) and server compute exactly the same.

// --- Quantities ---------------------------------------------------------------

const QTY_RE = /^([+-])?(\d+)(?:[.,](\d{1,3}))?$/;

/** "0,250" → 250. Three decimals at most (R-VTE-04). Returns null when invalid. */
export function parseQtyToMilli(input: string): number | null {
  const m = QTY_RE.exec(input.replace(/\s/g, ''));
  if (!m) return null;
  const v = Number(m[2]) * 1000 + Number((m[3] ?? '').padEnd(3, '0'));
  return m[1] === '-' ? -v : v;
}

export function milliToDecimal(milli: number): string {
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
}

/** Display: "1", "0,25", "1,5". */
export function formatQty(milli: number): string {
  return (milli / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 });
}

/** Rounds a / b half away from zero (integers only). */
function divRound(a: number, b: number): number {
  const q = Math.floor((Math.abs(a) * 2 + b) / (2 * b));
  return a < 0 ? -q : q;
}

// --- Lines and totals -----------------------------------------------------------

export interface LineInput {
  qtyMilli: number;
  unitPriceCents: number;
  discountCents: number;
}

/** §6.2: line_total = round(qty × unit_price − discount, 2). */
export function lineTotalCents(l: LineInput): number {
  return divRound(l.qtyMilli * l.unitPriceCents, 1000) - l.discountCents;
}

export function saleTotalCents(lines: readonly LineInput[]): number {
  return lines.reduce((s, l) => s + lineTotalCents(l), 0);
}

/** R-VTE-07: a discount in % of the line amount, rounded to the cent. */
export function percentDiscountCents(l: Omit<LineInput, 'discountCents'>, percent: number): number {
  return divRound(
    divRound(l.qtyMilli * l.unitPriceCents, 1000) * Math.round(percent * 100),
    10_000,
  );
}

// --- Payments (R-VTE-09) --------------------------------------------------------

export const PAYMENT_METHODS = ['CASH', 'CHEQUE', 'CARD', 'WALLET', 'TRANSFER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Espèces',
  CHEQUE: 'Chèque',
  CARD: 'Carte',
  WALLET: 'Cagnotte',
  TRANSFER: 'Virement',
};

export interface PaymentInput {
  method: PaymentMethod;
  /** Amount applied to the sale. */
  amountCents: number;
}

export interface PaymentState {
  paidCents: number;
  remainingCents: number;
  settled: boolean;
}

export function paymentState(totalCents: number, payments: readonly PaymentInput[]): PaymentState {
  const paidCents = payments.reduce((s, p) => s + p.amountCents, 0);
  const remainingCents = totalCents - paidCents;
  return { paidCents, remainingCents, settled: remainingCents === 0 };
}

/**
 * Applies a payment typed by the cashier. Only cash can exceed the remaining amount;
 * the excess is the change (R-VTE-09). Other methods are capped at the remaining amount.
 */
export function applyPayment(
  remainingCents: number,
  method: PaymentMethod,
  tenderedCents: number,
): { amountCents: number; changeCents: number } {
  if (tenderedCents <= 0 || remainingCents <= 0) return { amountCents: 0, changeCents: 0 };
  if (method === 'CASH' && tenderedCents > remainingCents) {
    return { amountCents: remainingCents, changeCents: tenderedCents - remainingCents };
  }
  return { amountCents: Math.min(tenderedCents, remainingCents), changeCents: 0 };
}

// --- Cagnotte (R-CAG-04, R-OFF-04) -----------------------------------------------

/** R-CAG-04: the wallet may go down to −overdraft, not below. */
export function walletPaymentAllowed(
  balanceCents: number,
  amountCents: number,
  overdraftCents: number,
): boolean {
  return balanceCents - amountCents >= -overdraftCents;
}

export interface PendingWalletMove {
  householdId: string;
  /** Signed: purchases are negative, top-ups positive. */
  amountCents: number;
}

/** R-OFF-04: server balance at the last refresh plus the local moves not yet reflected in it. */
export function estimatedBalanceCents(
  householdId: string,
  serverBalanceCents: number,
  pending: readonly PendingWalletMove[],
): number {
  return pending
    .filter((p) => p.householdId === householdId)
    .reduce((s, p) => s + p.amountCents, serverBalanceCents);
}

// --- Cash count and closing (R-SES-02) --------------------------------------------

/** The 12 face values counted at closing, in cents (§2.4.6). */
export const DENOMINATIONS = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export function countedCashCents(counts: Readonly<Record<string, number>>): number {
  return DENOMINATIONS.reduce((s, d) => s + d * Math.max(0, Math.trunc(counts[String(d)] ?? 0)), 0);
}

export interface ClosingInput {
  openingFloatCents: number;
  /** Net cash taken by sales (cash payments minus refunds). */
  cashSalesCents: number;
  /** Cash received outside sales during the session: top-ups, memberships, donations. */
  cashOtherCents: number;
  countedCashCents: number;
  bankDepositCents: number;
}

export interface ClosingResult {
  expectedCashCents: number;
  differenceCents: number;
  nextFloatCents: number;
}

/**
 * R-SES-02 step 3. CA: float 100 €, cash sales 50 €, memberships in cash 12 €, top-up by
 * cheque 20 € → 162 € expected (the cheque is not cash).
 */
export function closing(i: ClosingInput): ClosingResult {
  const expectedCashCents = i.openingFloatCents + i.cashSalesCents + i.cashOtherCents;
  return {
    expectedCashCents,
    differenceCents: i.countedCashCents - expectedCashCents,
    nextFloatCents: i.countedCashCents - i.bankDepositCents,
  };
}

// --- Memberships (R-ADH-02, R-ADH-03) ----------------------------------------------

/** ISO date (YYYY-MM-DD) arithmetic in UTC, independent of the device time zone. */
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** R-ADH-02: end = start + duration − 1 day; a duration of 0 months is the same day only. */
export function membershipEnd(start: string, durationMonths: number): string {
  return durationMonths <= 0 ? start : addDays(addMonths(start, durationMonths), -1);
}

/**
 * Period of a membership bought on `saleDate`. A renewal bought while the current
 * membership is still valid starts the day after it ends, so no day is lost.
 */
export function membershipPeriod(
  saleDate: string,
  durationMonths: number,
  currentEnd: string | null,
): { start: string; end: string } {
  const start =
    durationMonths > 0 && currentEnd && currentEnd >= saleDate ? addDays(currentEnd, 1) : saleDate;
  return { start, end: membershipEnd(start, durationMonths) };
}

export type MembershipState = 'VALID' | 'EXPIRED' | 'NONE';

export function membershipState(end: string | null, today: string): MembershipState {
  if (!end) return 'NONE';
  return end >= today ? 'VALID' : 'EXPIRED';
}

// --- Barcodes and product lookup (R-VTE-03, R-PRD-01) ------------------------------

function gtinValid(code: string): boolean {
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** EAN-13 or EAN-8 with a correct check digit. */
export function isValidEan(code: string): boolean {
  return /^(\d{8}|\d{13})$/.test(code) && gtinValid(code);
}

export interface LookupProduct {
  id: string;
  code: string;
  name: string;
  eans: readonly string[];
}

export type LookupResult<P> =
  { kind: 'found'; product: P } | { kind: 'choices'; products: P[] } | { kind: 'none' };

/**
 * R-VTE-03: exact EAN, then exact product code, then a name search whose results the
 * cashier chooses from. Never a partial match on a code (anomaly C5).
 */
export function lookupProduct<P extends LookupProduct>(
  products: readonly P[],
  input: string,
  maxChoices = 20,
): LookupResult<P> {
  const q = input.trim();
  if (!q) return { kind: 'none' };
  if (/^\d+$/.test(q)) {
    const byEan = products.find((p) => p.eans.includes(q));
    if (byEan) return { kind: 'found', product: byEan };
    const byCode = products.find((p) => p.code === q);
    if (byCode) return { kind: 'found', product: byCode };
    return { kind: 'none' };
  }
  const words = normalizeSearch(q).split(' ');
  const matches = products.filter((p) => {
    const name = normalizeSearch(p.name);
    return words.every((w) => name.includes(w));
  });
  return matches.length
    ? { kind: 'choices', products: matches.slice(0, maxChoices) }
    : { kind: 'none' };
}

// --- Ticket numbers (R-VTE-10, R-SYNC-05) -------------------------------------------

export function formatSaleNumber(year: number, n: number): string {
  return `T-${year}-${String(n).padStart(6, '0')}`;
}

export function provisionalNumber(deviceName: string, deviceSeq: number): string {
  return `${deviceName}-${String(deviceSeq).padStart(4, '0')}`;
}

// --- Low-wallet alert at the till -------------------------------------------------

/** Below this balance the cashier is invited to suggest a top-up. */
export const LOW_WALLET_CENTS = 500;

export type WalletAlert = 'NEGATIVE' | 'INSUFFICIENT' | 'LOW' | null;

/**
 * Alert shown next to the household's wallet at the till:
 * NEGATIVE: already below zero; INSUFFICIENT: the current ticket could not be paid from
 * the wallet alone (balance − total below −overdraft); LOW: under the top-up threshold.
 */
export function walletAlert(
  balanceCents: number,
  ticketTotalCents: number,
  overdraftCents: number,
  lowCents = LOW_WALLET_CENTS,
): WalletAlert {
  if (balanceCents < 0) return 'NEGATIVE';
  if (ticketTotalCents > 0 && !walletPaymentAllowed(balanceCents, ticketTotalCents, overdraftCents))
    return 'INSUFFICIENT';
  if (balanceCents < lowCents) return 'LOW';
  return null;
}
