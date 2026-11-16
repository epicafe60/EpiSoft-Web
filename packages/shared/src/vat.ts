import { centsToDecimal, parseAmountToCents } from './money';

// VAT rules, in one place (R-TVA-*). Pure functions on integer cents, shared by the API (source of
// truth), the till (offline ticket) and the forms.
//
// Sales: the prices are TTC. The VAT included in a ticket is computed BY RATE, never per line:
// HT = round(sum of the TTC of the rate / (1 + rate)), VAT = TTC - HT (rounding each line would
// drift by several cents over a day; this is what the French rules and the market tills do).
// Purchases: HT x rate = VAT within a small rounding tolerance, HT + VAT = TTC.

/** The VAT rates of mainland France (2.1 % is for the press and some medicines). */
export const STANDARD_VAT_RATES = ['0.00', '2.10', '5.50', '10.00', '20.00'] as const;

/**
 * The VAT regime of the association (an application parameter, effective from a date, see
 * `regimeAt`): LIABLE (assujetti, the default), FRANCHISE en base (art. 293 B du CGI) or EXEMPT
 * (exonération des organismes sans but lucratif, art. 261 du CGI et suivants). Outside LIABLE no
 * VAT is charged nor recoverable: no breakdown by rate on the tickets, the closings and the
 * reports, sales booked TTC on 707, supplier invoices booked TTC as an expense.
 */
export const VAT_REGIMES = ['LIABLE', 'FRANCHISE', 'EXEMPT'] as const;
export type VatRegime = (typeof VAT_REGIMES)[number];
export const VAT_REGIME_LABELS: Record<VatRegime, string> = {
  LIABLE: 'Assujettie à la TVA',
  FRANCHISE: 'Franchise en base de TVA (art. 293 B du CGI)',
  EXEMPT: 'Exonérée de TVA (art. 261 du CGI, organisme sans but lucratif)',
};

/** Compulsory mention on the tickets and invoices of a business under the franchise. */
export const FRANCHISE_MENTION = 'TVA non applicable, art. 293 B du CGI';
/** Mention for the exempt regime. */
export const EXEMPT_MENTION = 'Exonération de TVA, art. 261 du CGI';

export const isLiable = (regime: VatRegime): boolean => regime === 'LIABLE';

/** The mention printed instead of the VAT, null when liable. */
export function regimeMention(regime: VatRegime): string | null {
  return regime === 'FRANCHISE' ? FRANCHISE_MENTION : regime === 'EXEMPT' ? EXEMPT_MENTION : null;
}

export interface VatRegimeChange {
  /** ISO date (shop time zone) from which the regime applies. */
  effectiveFrom: string;
  regime: VatRegime;
}

/** The regime in force on a date: the latest change on or before it, LIABLE before the first. */
export function regimeAt(changes: readonly VatRegimeChange[], date: string): VatRegime {
  let best: VatRegimeChange | null = null;
  for (const c of changes)
    if (c.effectiveFrom <= date && (!best || c.effectiveFrom > best.effectiveFrom)) best = c;
  return best?.regime ?? 'LIABLE';
}

/**
 * A change of regime takes effect on a date and never recomputes past operations (each ticket and
 * invoice keeps the regime of its date). Refused: a date inside a closed fiscal year, a date that
 * already has a change, a change that leaves the regime as it is on that date.
 */
export function vatRegimeChangeProblem(
  change: VatRegimeChange,
  existing: readonly VatRegimeChange[],
  closedYears: readonly { startDate: string; endDate: string; label: string }[],
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change.effectiveFrom)) return 'Date d’effet invalide.';
  const year = closedYears.find(
    (y) => change.effectiveFrom >= y.startDate && change.effectiveFrom <= y.endDate,
  );
  if (year)
    return `Cette date tombe dans l’exercice clos « ${year.label} » : un changement de régime ne peut pas modifier une année clôturée.`;
  if (existing.some((c) => c.effectiveFrom === change.effectiveFrom))
    return 'Un changement de régime existe déjà à cette date.';
  if (regimeAt(existing, change.effectiveFrom) === change.regime)
    return 'Ce régime est déjà celui en vigueur à cette date.';
  return null;
}

/** Rounding tolerance of the VAT of an invoice line, in cents (suppliers round per line). */
export const INVOICE_LINE_VAT_TOLERANCE_CENTS = 2;
/** Tolerance of the VAT amount of a product purchase price, in cents. */
export const PURCHASE_VAT_TOLERANCE_CENTS = 1;

/** "5.5", "5,50" gives 550 basis points; null when it is not a number. */
export function rateToBp(rate: string): number | null {
  const n = Number(rate.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** 550 gives "5.50". */
export function bpToRate(bp: number): string {
  return (bp / 100).toFixed(2);
}

/** "5.5" gives "5.50"; null when it is not a standard rate. */
export function normalizeVatRate(rate: string): string | null {
  const bp = rateToBp(rate);
  if (bp === null) return null;
  const r = bpToRate(bp);
  return (STANDARD_VAT_RATES as readonly string[]).includes(r) ? r : null;
}

/** "5.50" gives "5,5 %". */
export function formatVatRate(rate: string): string {
  const bp = rateToBp(rate) ?? 0;
  return `${String(bp / 100).replace('.', ',')} %`;
}

/** Division rounded half away from zero (credit notes are negative). */
export function divRoundCents(a: number, b: number): number {
  const q = Math.floor((Math.abs(a) * 2 + b) / (2 * b));
  return a < 0 ? -q : q;
}

/** VAT of an amount excl. VAT: round(HT x rate). */
export function vatOfExclCents(exclCents: number, rate: string): number {
  return divRoundCents(exclCents * (rateToBp(rate) ?? 0), 10_000);
}

/** VAT of a purchase price excl. VAT in ten-thousandths of a euro (price4): round(HT x rate). */
export function vatOfExcl4(excl4: number, rate: string): number {
  return divRoundCents(excl4 * (rateToBp(rate) ?? 0), 10_000);
}

/** HT contained in an amount incl. VAT: round(TTC / (1 + rate)). */
export function exclOfInclCents(inclCents: number, rate: string): number {
  return divRoundCents(inclCents * 10_000, 10_000 + (rateToBp(rate) ?? 0));
}

// --- Sales: the VAT included in the TTC prices, by rate --------------------------------------

export interface VatSaleLine {
  /** VAT rate of the product, "5.50". */
  rate: string;
  /** Line total TTC after discount, in cents (negative for a cancellation). */
  inclCents: number;
  /** Out of the scope of VAT (a donation): left out of the breakdown. */
  outOfScope?: boolean;
}

export interface VatRateTotals {
  rate: string;
  exclCents: number;
  vatCents: number;
  inclCents: number;
}

export interface VatBreakdown {
  /** One row per rate, in ascending order of rate. */
  byRate: VatRateTotals[];
  exclCents: number;
  vatCents: number;
  /** Total TTC of the lines subject to VAT. */
  inclCents: number;
  /** TTC of the lines out of the scope of VAT (donations). */
  outOfScopeCents: number;
}

/**
 * R-TVA-01: VAT included in TTC amounts, grouped by rate. HT = round(sum TTC of the rate / (1+rate)),
 * VAT = sum TTC - HT. Never rounded line by line: sum HT + sum VAT = sum TTC exactly.
 */
export function vatBreakdownIncl(lines: readonly VatSaleLine[]): VatBreakdown {
  const sums = new Map<number, number>();
  let outOfScopeCents = 0;
  for (const l of lines) {
    if (l.outOfScope) {
      outOfScopeCents += l.inclCents;
      continue;
    }
    const bp = rateToBp(l.rate) ?? 0;
    sums.set(bp, (sums.get(bp) ?? 0) + l.inclCents);
  }
  const byRate = [...sums.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bp, inclCents]) => {
      const rate = bpToRate(bp);
      const exclCents = exclOfInclCents(inclCents, rate);
      return { rate, exclCents, vatCents: inclCents - exclCents, inclCents };
    });
  return {
    byRate,
    exclCents: byRate.reduce((s, r) => s + r.exclCents, 0),
    vatCents: byRate.reduce((s, r) => s + r.vatCents, 0),
    inclCents: byRate.reduce((s, r) => s + r.inclCents, 0),
    outOfScopeCents,
  };
}

export interface VatGroup {
  /** What the amount belongs to (a revenue account). */
  key: string;
  rate: string;
  inclCents: number;
}

/**
 * Splits the TTC of groups (revenue accounts) into HT per group, so that, for each rate, the sum of
 * the HT of its groups is exactly the HT computed on the whole rate (R-TVA-01). The group with the
 * largest TTC absorbs the rounding remainder (a few cents at most).
 */
export function allocateExclByRate<G extends VatGroup>(
  groups: readonly G[],
): (G & { exclCents: number })[] {
  const out = groups.map((g) => ({ ...g, exclCents: exclOfInclCents(g.inclCents, g.rate) }));
  const rates = new Set(groups.map((g) => rateToBp(g.rate) ?? 0));
  for (const bp of rates) {
    const members = out.filter((g) => (rateToBp(g.rate) ?? 0) === bp);
    const total = exclOfInclCents(
      members.reduce((s, g) => s + g.inclCents, 0),
      bpToRate(bp),
    );
    const drift = total - members.reduce((s, g) => s + g.exclCents, 0);
    if (drift !== 0) {
      const biggest = members.reduce((a, b) =>
        Math.abs(b.inclCents) > Math.abs(a.inclCents) ? b : a,
      );
      biggest.exclCents += drift;
    }
  }
  return out;
}

export interface TicketVat {
  /** One row per rate (empty under the franchise regime). */
  rows: VatRateTotals[];
  /** The franchise mention, printed instead of the rows. */
  mention: string | null;
}

/** R-TVA-05: what a ticket prints about VAT, from its lines (TTC) and the regime. */
export function ticketVat(lines: readonly VatSaleLine[], regime: VatRegime): TicketVat {
  if (!isLiable(regime)) return { rows: [], mention: regimeMention(regime) };
  return { rows: vatBreakdownIncl(lines).byRate, mention: null };
}

export interface RevenueGroup {
  /** Revenue account (707, 756, 754 or a shelf's own account). */
  account: string;
  rate: string;
  inclCents: number;
  /** A donation: credited in full, without VAT. */
  outOfScope?: boolean;
  /** Regime of the tickets of the group (their snapshot). Default LIABLE. */
  regime?: VatRegime;
}

/**
 * R-TVA-04: from the TTC revenue of a session by account and rate, the HT credited to each revenue
 * account and the VAT collected by rate. Outside the LIABLE regime (or at 0 %) nothing is split:
 * the revenue is the TTC. Σ revenue + Σ VAT = Σ TTC, always.
 */
export function splitRevenueVat(
  groups: readonly RevenueGroup[],
  collectedAccountOf: (rate: string) => string | null,
): {
  revenue: Record<string, number>;
  vatCollected: { account: string; rate: string; cents: number }[];
} {
  const revenue: Record<string, number> = {};
  const add = (account: string, cents: number) => {
    revenue[account] = (revenue[account] ?? 0) + cents;
  };
  const taxed: (VatGroup & { account: string })[] = [];
  for (const g of groups) {
    const vatAccount = collectedAccountOf(g.rate);
    if (
      !isLiable(g.regime ?? 'LIABLE') ||
      g.outOfScope ||
      (rateToBp(g.rate) ?? 0) === 0 ||
      !vatAccount
    )
      add(g.account, g.inclCents);
    else
      taxed.push({
        key: g.account,
        account: g.account,
        rate: bpToRate(rateToBp(g.rate)!),
        inclCents: g.inclCents,
      });
  }
  const vatByRate = new Map<string, number>();
  for (const g of allocateExclByRate(taxed)) {
    add(g.account, g.exclCents);
    vatByRate.set(g.rate, (vatByRate.get(g.rate) ?? 0) + g.inclCents - g.exclCents);
  }
  const vatCollected = [...vatByRate.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([rate, cents]) => ({ account: collectedAccountOf(rate)!, rate, cents }));
  return { revenue, vatCollected };
}

// --- Purchases ----------------------------------------------------------------------------

/**
 * R-TVA-02: a product purchase price. The typed VAT amount must equal HT x rate within one cent,
 * and HT + VAT = TTC. Amounts in price4 (ten-thousandths of a euro). Empty fields are not checked.
 */
export function purchaseVatProblem(p: {
  excl4: number | null;
  vat4: number | null;
  incl4: number | null;
  /** Absent: the amounts are only checked against each other. */
  rate?: string | null;
}): string | null {
  const { excl4, vat4, incl4 } = p;
  if (excl4 !== null && incl4 !== null && incl4 < excl4)
    return 'Le PA TTC ne peut pas être inférieur au PA HT.';
  if (excl4 !== null && vat4 !== null && p.rate) {
    const expected = Math.round(((rateToBp(p.rate) ?? 0) * excl4) / 10_000);
    if (Math.abs(vat4 - expected) > PURCHASE_VAT_TOLERANCE_CENTS * 100)
      return `Le montant de TVA ne correspond pas au taux de ${formatVatRate(p.rate)} du produit (HT × taux = ${(expected / 10_000).toFixed(4)} €, à 1 centime près).`;
  }
  if (excl4 !== null && vat4 !== null && incl4 !== null && excl4 + vat4 !== incl4)
    return 'Le PA TTC doit être égal au PA HT plus le montant de TVA.';
  return null;
}

// --- Supplier invoices: breakdown by rate --------------------------------------------------

export interface InvoiceVatLine {
  rate: string;
  /** Amounts as decimal strings ("100.00"). */
  excl: string;
  vat: string;
}

export interface InvoiceTotals {
  exclCents: number;
  vatCents: number;
  inclCents: number;
}

/** The totals of an invoice are derived: sums of the lines, TTC = HT + VAT. */
export function invoiceTotalsFromLines(lines: readonly InvoiceVatLine[]): InvoiceTotals {
  let exclCents = 0;
  let vatCents = 0;
  for (const l of lines) {
    exclCents += parseAmountToCents(l.excl) ?? 0;
    vatCents += parseAmountToCents(l.vat) ?? 0;
  }
  return { exclCents, vatCents, inclCents: exclCents + vatCents };
}

/** Same, as decimal strings, for the columns of the invoice. */
export function invoiceTotalsDecimal(lines: readonly InvoiceVatLine[]) {
  const t = invoiceTotalsFromLines(lines);
  return {
    totalExcl: centsToDecimal(t.exclCents),
    totalVat: centsToDecimal(t.vatCents),
    totalIncl: centsToDecimal(t.inclCents),
  };
}

/**
 * R-TVA-03: the lines of a supplier invoice. At least one line, one per rate, a standard rate,
 * HT > 0, VAT >= 0, and the VAT of each line equals HT x rate within 2 cents.
 */
export function invoiceVatLinesProblem(lines: readonly InvoiceVatLine[]): string | null {
  if (lines.length === 0) return 'Ajoutez au moins une ligne de TVA.';
  const seen = new Set<string>();
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    const rate = normalizeVatRate(l.rate);
    if (rate === null) return `Ligne ${n} : taux de TVA non reconnu (0, 2,1, 5,5, 10 ou 20 %).`;
    if (seen.has(rate))
      return `Le taux de ${formatVatRate(rate)} figure deux fois : regroupez-le sur une seule ligne.`;
    seen.add(rate);
    const e = parseAmountToCents(l.excl);
    const v = parseAmountToCents(l.vat);
    if (e === null || v === null) return `Ligne ${n} : montant invalide.`;
    if (e <= 0) return `Ligne ${n} : le montant HT doit être positif.`;
    if (v < 0) return `Ligne ${n} : la TVA ne peut pas être négative.`;
    const expected = vatOfExclCents(e, rate);
    if (Math.abs(v - expected) > INVOICE_LINE_VAT_TOLERANCE_CENTS)
      return `Ligne ${n} : la TVA à ${formatVatRate(rate)} de ${centsToDecimal(e)} € HT doit valoir ${centsToDecimal(expected)} € (à 2 centimes près), pas ${centsToDecimal(v)} €.`;
  }
  return null;
}

/**
 * Legacy invoices only had three totals. The migration puts them on one line, at the standard rate
 * nearest to VAT / HT (the real breakdown is unknown), or at 0 % when there is no VAT.
 */
export function nearestStandardRate(exclCents: number, vatCents: number): string {
  if (exclCents <= 0 || vatCents <= 0) return '0.00';
  const pct = (vatCents / exclCents) * 100;
  let best: string = STANDARD_VAT_RATES[0];
  for (const r of STANDARD_VAT_RATES)
    if (Math.abs(Number(r) - pct) < Math.abs(Number(best) - pct)) best = r;
  return best;
}

// --- Accounts ---------------------------------------------------------------------------------

/** Key (in the `accounting.accounts` setting) of the collected VAT account of a rate (4457xx). */
export const VAT_COLLECTED_KEYS = {
  '20.00': 'vatCollected20',
  '10.00': 'vatCollected10',
  '5.50': 'vatCollected55',
  '2.10': 'vatCollected21',
} as const;

export type VatCollectedKey = (typeof VAT_COLLECTED_KEYS)[keyof typeof VAT_COLLECTED_KEYS];

/** null for 0 %: no VAT to book. */
export function vatCollectedKey(rate: string): VatCollectedKey | null {
  const r = normalizeVatRate(rate);
  return r && r in VAT_COLLECTED_KEYS
    ? VAT_COLLECTED_KEYS[r as keyof typeof VAT_COLLECTED_KEYS]
    : null;
}

/** "12 rue des Écoles, 60240 Montjavoult"; null when nothing is known. */
export function identityAddress(i: {
  street: string | null;
  postcode: string | null;
  city: string | null;
}): string | null {
  const place = [i.postcode, i.city].filter(Boolean).join(' ');
  const full = [i.street, place].filter(Boolean).join(', ');
  return full === '' ? null : full;
}
