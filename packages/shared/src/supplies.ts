import { addDays } from './pos';

// Supplies and stock rules (spec §4.6–§4.10). Purchase prices have 4 decimals: they are
// handled as integers in ten-thousandths of a euro ("price4"), quantities in thousandths.

/** "1.2345" → 12345. Returns null when invalid. */
export function parsePrice4(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const m = /^(-)?(\d+)(?:[.,](\d{1,4}))?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[2]) * 10_000 + Number((m[3] ?? '').padEnd(4, '0'));
  return m[1] ? -n : n;
}

export function price4ToDecimal(p: number): string {
  const sign = p < 0 ? '-' : '';
  const a = Math.abs(p);
  return `${sign}${Math.floor(a / 10_000)}.${String(a % 10_000).padStart(4, '0')}`;
}

function divRound(a: number, b: number): number {
  const q = Math.floor((Math.abs(a) * 2 + b) / (2 * b));
  return a < 0 ? -q : q;
}

/** VAT rate "5.50" → 550 basis points. */
export function vatBp(rate: string): number {
  return Math.round(Number(rate) * 100);
}

// --- Orders (R-CMD-01) ---------------------------------------------------------------

/** max(0, stock min − stock + reservations), in thousandths. */
export function suggestedOrderQtyMilli(
  minStockMilli: number | null,
  stockMilli: number,
  reservedMilli = 0,
): number {
  if (minStockMilli === null) return 0;
  return Math.max(0, minStockMilli - stockMilli + reservedMilli);
}

export interface OrderLineInput {
  qtyMilli: number;
  unitPriceExcl4: number;
  vatRate: string;
}

export interface Totals {
  exclCents: number;
  vatCents: number;
  inclCents: number;
}

/** Totals of a line: HT rounded to the cent, VAT on that HT, TTC = HT + VAT. */
export function orderLineTotals(l: OrderLineInput): Totals {
  const exclCents = divRound(l.qtyMilli * l.unitPriceExcl4, 100_000);
  const vatCents = divRound(exclCents * vatBp(l.vatRate), 10_000);
  return { exclCents, vatCents, inclCents: exclCents + vatCents };
}

/** R-CMD-01: computed per line, then added up (coherent HT/TVA/TTC, R-CMD-03). */
export function orderTotals(lines: readonly OrderLineInput[]): Totals {
  return lines.map(orderLineTotals).reduce(
    (t, x) => ({
      exclCents: t.exclCents + x.exclCents,
      vatCents: t.vatCents + x.vatCents,
      inclCents: t.inclCents + x.inclCents,
    }),
    { exclCents: 0, vatCents: 0, inclCents: 0 },
  );
}

// --- Margin and selling price (R-PRD-03, open question Q2) ------------------------------

/** PA TTC = PA HT × (1 + VAT), in price4. */
export function inclFromExcl4(excl4: number, vatRate: string): number {
  return divRound(excl4 * (10_000 + vatBp(vatRate)), 10_000);
}

/**
 * Q2 default: markup rate on the selling price, (PV − PA TTC) / PV, and coefficient
 * PV / PA TTC. Both returned as numbers (rate in %), or null when not computable.
 */
export function margin(
  salePriceCents: number,
  purchaseIncl4: number | null,
): { ratePct: number; coefficient: number } | null {
  if (!purchaseIncl4 || purchaseIncl4 <= 0 || salePriceCents <= 0) return null;
  const pa = purchaseIncl4 / 100; // in cents, fractional
  return {
    ratePct: Math.round(((salePriceCents - pa) / salePriceCents) * 10_000) / 100,
    coefficient: Math.round((salePriceCents / pa) * 1000) / 1000,
  };
}

export type PriceRounding = 1 | 5 | 10;

/** Rounds a price in cents to the nearest step (1, 5 or 10 cents), half up. */
export function roundPrice(cents: number, step: PriceRounding): number {
  return Math.floor((cents + step / 2) / step) * step;
}

/** Selling price giving a target markup rate: PV = PA TTC / (1 − rate). */
export function salePriceForMarkup(
  purchaseIncl4: number,
  ratePct: number,
  step: PriceRounding,
): number | null {
  if (ratePct >= 100 || purchaseIncl4 <= 0) return null;
  return roundPrice(Math.round(purchaseIncl4 / 100 / (1 - ratePct / 100)), step);
}

export function salePriceForCoefficient(
  purchaseIncl4: number,
  coefficient: number,
  step: PriceRounding,
): number | null {
  if (coefficient <= 0 || purchaseIncl4 <= 0) return null;
  return roundPrice(Math.round((purchaseIncl4 / 100) * coefficient), step);
}

// --- Suppliers and invoices -------------------------------------------------------------

/** R-FNR-01: region (2 digits) + sequence, with no limit of 99. */
export function nextSupplierCode(existing: readonly string[], region: string): string {
  const r = region.padStart(2, '0');
  const seqs = existing
    .filter((c) => c.startsWith(r) && /^\d+$/.test(c.slice(2)))
    .map((c) => Number(c.slice(2)));
  const next = (seqs.length ? Math.max(...seqs) : 0) + 1;
  return `${r}${String(next).padStart(2, '0')}`;
}

/** R-FAC-01: due date from the supplier's payment terms. */
export function invoiceDueDate(date: string, termsDays: number): string {
  return addDays(date, Math.max(0, termsDays));
}

export interface InvoiceLike {
  id?: string;
  supplierId: string;
  pieceRef: string;
  date: string;
  totalIncl: string;
}

const dayDiff = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** R-FAC-05: probable duplicate — same supplier, and same piece or same amount within ±7 days. */
export function probableDuplicates<T extends InvoiceLike>(
  candidate: InvoiceLike,
  others: readonly T[],
): T[] {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  return others.filter(
    (o) =>
      o.id !== candidate.id &&
      o.supplierId === candidate.supplierId &&
      (norm(o.pieceRef) === norm(candidate.pieceRef) ||
        (Number(o.totalIncl) === Number(candidate.totalIncl) &&
          dayDiff(o.date, candidate.date) <= 7)),
  );
}

// --- Inventory and valuation (R-STK-04, R-STK-06) ------------------------------------------

/**
 * Movement to apply for a counted product: counted − (theoretical at opening + movements
 * between the opening and the count). Sales made while counting are not counted twice.
 */
export function inventoryAdjustmentMilli(
  theoreticalAtOpeningMilli: number,
  movedUntilCountMilli: number,
  countedMilli: number,
): number {
  return countedMilli - (theoreticalAtOpeningMilli + movedUntilCountMilli);
}

/** Value of a quantity at a price4, in cents. Negative stocks count as zero. */
export function stockValueCents(qtyMilli: number, price4: number | null): number {
  if (!price4 || qtyMilli <= 0) return 0;
  return divRound(qtyMilli * price4, 100_000);
}

/** Readable numbers: CF-2026-0001 (orders), RC-2026-0001 (receipts). */
export function formatDocNumber(prefix: 'CF' | 'RC', year: number, n: number): string {
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}
