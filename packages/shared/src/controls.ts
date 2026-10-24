import { inclFromExcl4 } from './supplies';
import { normalizeSearch } from './text';

// Protections and warnings (docs/evols plan « protections »). Everything here is a pure
// function: the till, the API and the tests share the same rules. A warning never blocks
// by itself; the screens ask the user to check, and the server records and reports.

/** Thresholds editable in the administration screen (setting `controls.thresholds`). */
export interface Thresholds {
  /** A line quantity above this is suspicious (a typed 100 instead of 10). */
  qtyMax: number;
  /** Euros: a line / a whole ticket above these amounts. */
  lineAmount: number;
  ticketAmount: number;
  /** A price differing from the catalogue by more than this percent. */
  priceDeviationPct: number;
  /** A line discount above this percent. */
  discountPct: number;
  /** Euros: change to give back above this amount. */
  changeAmount: number;
  /** Euros: a cash difference above this at closing needs a comment. */
  cashGap: number;
  /** The till clock ahead by more than this many minutes, or late by more than these hours. */
  clockFutureMin: number;
  clockPastHours: number;
  /** A purchase price differing from the previous one by more than this percent. */
  purchaseVariationPct: number;
  /** Inventory: a line off by more than this percent or euros, a total above this amount. */
  inventoryLinePct: number;
  inventoryLineAmount: number;
  inventoryTotalAmount: number;
  /** Euros: a top-up / a correction of a cagnotte above these amounts. */
  topupAmount: number;
  correctionAmount: number;
  /** Till health, in minutes (hours for the session). */
  offlineMin: number;
  snapshotStaleMin: number;
  pendingMin: number;
  sessionHours: number;
  /** A backup older than this many hours is late. */
  backupHours: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  qtyMax: 50,
  lineAmount: 150,
  ticketAmount: 300,
  priceDeviationPct: 50,
  discountPct: 30,
  changeAmount: 50,
  cashGap: 5,
  clockFutureMin: 10,
  clockPastHours: 72,
  purchaseVariationPct: 20,
  inventoryLinePct: 30,
  inventoryLineAmount: 50,
  inventoryTotalAmount: 200,
  topupAmount: 200,
  correctionAmount: 50,
  offlineMin: 30,
  snapshotStaleMin: 60,
  pendingMin: 15,
  sessionHours: 24,
  backupHours: 26,
};

/** Labels of the thresholds, in the order of the administration screen. */
export const THRESHOLD_LABELS: Record<keyof Thresholds, { label: string; unit: string }> = {
  qtyMax: { label: 'Quantité d’une ligne de ticket', unit: 'unités' },
  lineAmount: { label: 'Montant d’une ligne de ticket', unit: '€' },
  ticketAmount: { label: 'Montant d’un ticket', unit: '€' },
  priceDeviationPct: { label: 'Écart du prix saisi avec le catalogue', unit: '%' },
  discountPct: { label: 'Remise sur une ligne', unit: '%' },
  changeAmount: { label: 'Monnaie à rendre', unit: '€' },
  cashGap: { label: 'Écart de caisse à la clôture (commentaire exigé)', unit: '€' },
  clockFutureMin: { label: 'Horloge du poste en avance de plus de', unit: 'minutes' },
  clockPastHours: { label: 'Ticket daté de plus de', unit: 'heures' },
  purchaseVariationPct: { label: 'Variation du prix d’achat à la réception', unit: '%' },
  inventoryLinePct: { label: 'Écart d’inventaire d’un produit', unit: '%' },
  inventoryLineAmount: { label: 'Écart d’inventaire d’un produit (valeur)', unit: '€' },
  inventoryTotalAmount: { label: 'Écart d’inventaire total (valeur)', unit: '€' },
  topupAmount: { label: 'Versement sur une cagnotte', unit: '€' },
  correctionAmount: { label: 'Correction d’une cagnotte', unit: '€' },
  offlineMin: { label: 'Caisse hors ligne depuis plus de', unit: 'minutes' },
  snapshotStaleMin: {
    label: 'Données de la caisse non rafraîchies depuis plus de',
    unit: 'minutes',
  },
  pendingMin: { label: 'Ticket en attente d’envoi depuis plus de', unit: 'minutes' },
  sessionHours: { label: 'Session de caisse ouverte depuis plus de', unit: 'heures' },
  backupHours: { label: 'Dernière sauvegarde plus ancienne que', unit: 'heures' },
};

const cents = (euros: number) => Math.round(euros * 100);

// --- Ticket (till and server) ---------------------------------------------------------------

export interface WarnLine {
  label: string;
  qtyMilli: number;
  unitPriceCents: number;
  catalogPriceCents: number;
  discountCents: number;
}

export type TicketWarningCode =
  | 'QTY_HIGH'
  | 'LINE_AMOUNT'
  | 'TICKET_AMOUNT'
  | 'PRICE_FAR'
  | 'PRICE_ZERO'
  | 'DISCOUNT_HIGH'
  | 'CHANGE_HIGH';

export interface TicketWarning {
  code: TicketWarningCode;
  message: string;
  /** Index of the line concerned, when there is one. */
  line?: number;
}

const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

/**
 * What looks wrong on a ticket before it is paid: a typed 100 instead of 10, a price very
 * far from the catalogue, a high discount, a large change. Never blocks.
 */
export function ticketWarnings(
  lines: readonly WarnLine[],
  changeCents: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): TicketWarning[] {
  const out: TicketWarning[] = [];
  let total = 0;
  lines.forEach((l, i) => {
    const gross = Math.round((l.qtyMilli * l.unitPriceCents) / 1000);
    const net = gross - l.discountCents;
    total += net;
    if (l.qtyMilli > t.qtyMax * 1000)
      out.push({
        code: 'QTY_HIGH',
        line: i,
        message: `${l.label} : quantité de ${l.qtyMilli / 1000}. Est-ce bien la bonne quantité ?`,
      });
    if (net > cents(t.lineAmount))
      out.push({
        code: 'LINE_AMOUNT',
        line: i,
        message: `${l.label} : ${eur(net)} sur une seule ligne.`,
      });
    if (l.catalogPriceCents > 0 && l.unitPriceCents === 0)
      out.push({
        code: 'PRICE_ZERO',
        line: i,
        message: `${l.label} est à 0 € alors que son prix habituel est ${eur(l.catalogPriceCents)}.`,
      });
    else if (l.catalogPriceCents > 0 && l.unitPriceCents > 0) {
      const dev = (Math.abs(l.unitPriceCents - l.catalogPriceCents) / l.catalogPriceCents) * 100;
      if (dev > t.priceDeviationPct)
        out.push({
          code: 'PRICE_FAR',
          line: i,
          message: `${l.label} : ${eur(l.unitPriceCents)} au lieu de ${eur(l.catalogPriceCents)} (prix habituel).`,
        });
    }
    if (l.discountCents > 0 && gross > 0) {
      const pct = (l.discountCents / gross) * 100;
      if (pct > t.discountPct)
        out.push({
          code: 'DISCOUNT_HIGH',
          line: i,
          message: `${l.label} : remise de ${Math.round(pct)} %.`,
        });
    }
  });
  if (total > cents(t.ticketAmount))
    out.push({ code: 'TICKET_AMOUNT', message: `Ticket de ${eur(total)} : montant élevé.` });
  if (changeCents > cents(t.changeAmount))
    out.push({
      code: 'CHANGE_HIGH',
      message: `Monnaie à rendre : ${eur(changeCents)}. Vérifiez la somme remise par le client.`,
    });
  return out;
}

/**
 * Server side: the till clock against the server clock. `soldAt` comes from the device;
 * a clock far ahead or far behind makes ticket numbers and dates wrong.
 */
export function clockSkew(
  soldAt: Date,
  now: Date,
  t: Thresholds = DEFAULT_THRESHOLDS,
): 'FUTURE' | 'PAST' | null {
  const diffMin = (soldAt.getTime() - now.getTime()) / 60_000;
  if (diffMin > t.clockFutureMin) return 'FUTURE';
  if (-diffMin > t.clockPastHours * 60) return 'PAST';
  return null;
}

// --- Till health ----------------------------------------------------------------------------

export interface TillHealthInput {
  online: boolean;
  /** Last successful contact with the server (snapshot refresh), ISO, or null. */
  lastContactAt: string | null;
  /** Creation date of the oldest ticket still waiting to be sent, or null. */
  oldestPendingAt: string | null;
  sessionOpenedAt: string | null;
}

export interface TillHealthWarning {
  code: 'OFFLINE_LONG' | 'SNAPSHOT_OLD' | 'PENDING_OLD' | 'SESSION_OLD';
  message: string;
}

const minutesSince = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 60_000;

/** Banners shown above the till when something has been waiting too long. */
export function tillHealth(
  now: Date,
  s: TillHealthInput,
  t: Thresholds = DEFAULT_THRESHOLDS,
): TillHealthWarning[] {
  const out: TillHealthWarning[] = [];
  const sinceContact = s.lastContactAt ? minutesSince(s.lastContactAt, now) : Infinity;
  if (!s.online && sinceContact > t.offlineMin)
    out.push({
      code: 'OFFLINE_LONG',
      message:
        'La caisse est hors ligne depuis un moment : les ventes sont gardées, mais vérifiez le réseau.',
    });
  if (s.online && sinceContact > t.snapshotStaleMin)
    out.push({
      code: 'SNAPSHOT_OLD',
      message: 'Les prix et les soldes de la caisse n’ont pas été rafraîchis depuis longtemps.',
    });
  if (s.oldestPendingAt && minutesSince(s.oldestPendingAt, now) > t.pendingMin)
    out.push({
      code: 'PENDING_OLD',
      message: 'Des tickets attendent d’être envoyés depuis plus de quelques minutes.',
    });
  if (s.sessionOpenedAt && minutesSince(s.sessionOpenedAt, now) > t.sessionHours * 60)
    out.push({
      code: 'SESSION_OLD',
      message: 'La session de caisse est ouverte depuis plus d’une journée : pensez à la clôturer.',
    });
  return out;
}

// --- Cash closing -----------------------------------------------------------------------------

/** A cash difference above the threshold needs a comment (and a second look). */
export function cashGapNeedsComment(differenceCents: number, t: Thresholds = DEFAULT_THRESHOLDS) {
  return Math.abs(differenceCents) > cents(t.cashGap);
}

// --- Purchase, margin, inventory --------------------------------------------------------------

/** Variation of a purchase price against the previous one, in percent (null: no previous price). */
export function priceVariationPct(previous4: number | null, next4: number): number | null {
  if (previous4 === null || previous4 <= 0) return null;
  return ((next4 - previous4) / previous4) * 100;
}

export function purchasePriceFlag(
  previous4: number | null,
  next4: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): { flagged: boolean; pct: number | null } {
  const pct = priceVariationPct(previous4, next4);
  return { flagged: pct !== null && Math.abs(pct) > t.purchaseVariationPct, pct };
}

/** True when the selling price (TTC, cents) is below the purchase price (TTC, cents). */
export function sellsBelowCost(salePriceCents: number, purchaseInclCents: number | null): boolean {
  return purchaseInclCents !== null && purchaseInclCents > 0 && salePriceCents < purchaseInclCents;
}

export interface PriceChange {
  oldSaleCents: number | null;
  newSaleCents: number;
  /** Purchase price excl. VAT in 1/10 000 €, and its VAT rate. */
  newPurchase4: number | null;
  vatRate: string;
  wasActive: boolean;
  active: boolean;
}

export interface BulkPriceImpact {
  count: number;
  /** Mean and largest change of the selling price, in percent (null: nothing comparable). */
  avgSalePct: number | null;
  maxSalePct: number | null;
  /** Selling price moved by more than the threshold. */
  bigJumps: number;
  /** New selling price below the new purchase price, or at 0 €. */
  belowCost: number;
  saleZero: number;
  deactivated: number;
}

/** What a grid of price changes would do, summed up for the confirmation window. */
export function bulkPriceImpact(
  changes: readonly PriceChange[],
  t: Thresholds = DEFAULT_THRESHOLDS,
): BulkPriceImpact {
  const pcts: number[] = [];
  let bigJumps = 0;
  let belowCost = 0;
  let saleZero = 0;
  let deactivated = 0;
  for (const c of changes) {
    if (c.oldSaleCents !== null && c.oldSaleCents > 0) {
      const pct = ((c.newSaleCents - c.oldSaleCents) / c.oldSaleCents) * 100;
      pcts.push(pct);
      if (Math.abs(pct) > t.priceDeviationPct) bigJumps++;
    }
    if (c.newSaleCents === 0) saleZero++;
    if (c.newPurchase4 !== null && c.newPurchase4 > 0) {
      const inclCents = Math.round(inclFromExcl4(c.newPurchase4, c.vatRate) / 100);
      if (c.newSaleCents < inclCents) belowCost++;
    }
    if (c.wasActive && !c.active) deactivated++;
  }
  return {
    count: changes.length,
    avgSalePct: pcts.length ? pcts.reduce((s, p) => s + p, 0) / pcts.length : null,
    maxSalePct: pcts.length ? pcts.reduce((m, p) => (Math.abs(p) > Math.abs(m) ? p : m), 0) : null,
    bigJumps,
    belowCost,
    saleZero,
    deactivated,
  };
}

export interface InventoryLineInput {
  theoreticalMilli: number;
  countedMilli: number | null;
  unitCostCents: number;
}

export interface InventoryImpact {
  /** Indexes of the lines whose gap is suspicious. */
  flagged: number[];
  /** Sum of the absolute values of the gaps, in cents. */
  totalGapCents: number;
  totalFlagged: boolean;
  /** Products that will be set to 0 because they were not counted. */
  willBeZeroed: number;
}

/** What validating an inventory would change, before the user confirms. */
export function inventoryImpact(
  lines: readonly InventoryLineInput[],
  zeroUncounted: boolean,
  t: Thresholds = DEFAULT_THRESHOLDS,
): InventoryImpact {
  const flagged: number[] = [];
  let total = 0;
  let zeroed = 0;
  lines.forEach((l, i) => {
    if (l.countedMilli === null) {
      if (zeroUncounted && l.theoreticalMilli !== 0) zeroed++;
      return;
    }
    const diff = l.countedMilli - l.theoreticalMilli;
    const value = Math.abs(Math.round((diff * l.unitCostCents) / 1000));
    total += value;
    const pct = (Math.abs(diff) / Math.max(Math.abs(l.theoreticalMilli), 1000)) * 100;
    if (diff !== 0 && (pct > t.inventoryLinePct || value > cents(t.inventoryLineAmount)))
      flagged.push(i);
  });
  return {
    flagged,
    totalGapCents: total,
    totalFlagged: total > cents(t.inventoryTotalAmount),
    willBeZeroed: zeroed,
  };
}

/** A cagnotte movement (top-up or correction) large enough to ask for a second look. */
export function walletMoveNeedsConfirm(
  kind: 'TOPUP' | 'CORRECTION',
  amountCents: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  const limit = kind === 'TOPUP' ? t.topupAmount : t.correctionAmount;
  return Math.abs(amountCents) > cents(limit);
}

// --- Names and addresses ----------------------------------------------------------------------

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Existing names that look like `name` (same once normalised, or one letter or two apart). */
export function similarNames(name: string, existing: readonly string[]): string[] {
  const n = normalizeSearch(name);
  if (n.length < 4) return [];
  return existing.filter((e) => {
    const m = normalizeSearch(e);
    if (m === n) return true;
    if (Math.min(n.length, m.length) < 6) return false;
    return distance(n, m) <= (n.length >= 12 ? 2 : 1);
  });
}

const COMMON_DOMAINS = [
  'gmail.com',
  'hotmail.com',
  'hotmail.fr',
  'outlook.com',
  'outlook.fr',
  'yahoo.fr',
  'yahoo.com',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'sfr.fr',
  'laposte.net',
  'icloud.com',
  'live.fr',
  'neuf.fr',
  'bbox.fr',
];

/** « marie@gmial.com » → « marie@gmail.com » when the domain is a typo of a common one. */
export function suggestEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain || COMMON_DOMAINS.includes(domain)) return null;
  const best = COMMON_DOMAINS.filter((d) => distance(domain, d) <= 2 && d.length >= 7).sort(
    (a, b) => distance(domain, a) - distance(domain, b),
  )[0];
  return best ? `${email.slice(0, at)}@${best}` : null;
}

export interface MemberLike {
  id?: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
}

const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

/** Members who may be the same person: same name once normalised, or same phone number. */
export function memberDuplicates<M extends MemberLike>(
  candidate: MemberLike,
  others: readonly M[],
): M[] {
  const key = (m: MemberLike) => normalizeSearch(`${m.firstName} ${m.lastName}`);
  const phone = digits(candidate.phone);
  return others.filter((o) => {
    if (candidate.id && o.id === candidate.id) return false;
    if (key(o) === key(candidate)) return true;
    const op = digits(o.phone);
    return phone.length >= 8 && op.length >= 8 && op.slice(-9) === phone.slice(-9);
  });
}
