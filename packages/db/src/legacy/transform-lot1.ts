import {
  centsToDecimal,
  cleanText,
  isValidEan,
  type PaymentMethod,
  type ProductKind,
  type ProductStatus,
  type Quality,
  type SaleCondition,
  type SaleMode,
  type Unit,
} from '@episoft/shared';
import type { Issue } from './transform';

// Pure legacy → v2 transforms for lot 1 (spec §6.3): catalogue, payments, tickets.

const SALE_MODE_BY_CODE: SaleMode[] = ['UNIT', 'WEIGHT', 'VOLUME'];
const UNIT_BY_CODE: Unit[] = ['G', 'KG', 'ML', 'L'];
const CONDITION_BY_CODE: SaleCondition[] = ['ON_SITE', 'ON_ORDER', 'BOTH'];
const STATUS_BY_CODE: ProductStatus[] = ['ON_ORDER', 'ACTIVE', 'INACTIVE', 'UNAVAILABLE'];
const QUALITY_BY_CODE: Quality[] = ['LOCAL', 'ORGANIC', 'SEASONAL', 'STANDARD'];

/** Rounds a JS number coming from a legacy float/decimal to `digits` decimals, as a string. */
export function fixed(v: number | string | null | undefined, digits: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return (Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f).toFixed(digits);
}

/** Legacy money (float or decimal) → integer cents, rounded half away from zero. */
export function legacyCents(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-9);
}

/**
 * `PRODQUALITE` is a comma list whose values repeat ("0,1,0,1,0,1") because of a form bug.
 * The distinct values are kept.
 */
export function parseQualities(v: string | null): Quality[] {
  const codes = new Set(
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-3]$/.test(s))
      .map(Number),
  );
  return QUALITY_BY_CODE.filter((_, i) => codes.has(i));
}

export interface LegacyProductRow {
  PRODNUM: string;
  PRODNOM: string | null;
  PRODESCR: string | null;
  PRODTYPVTE: number | null;
  PRODQTE: string | null;
  PRODUNITVTE: number | null;
  PRODEAN13: string | null;
  PRODCONDVTE: number | null;
  PRODFNR: string | null;
  PRODREFFNR: string | null;
  PRODUNIV: string | null;
  PRODRAY: string | null;
  PRODQUALITE: string | null;
  PRODTVATX: string | null;
  PRODATCREA: string | null;
  PRODSTATUT: number | null;
  PRODPAHT: string | null;
  PRODPATTC: string | null;
  PRODPRIXVTE: string | null;
  PRODSTOCK: string | null;
  PRODSTKMIN: string | null;
  PRODPACHG: number | null;
}

export interface ProductDraft {
  code: string;
  name: string;
  description: string | null;
  kind: ProductKind;
  saleMode: SaleMode;
  unitQty: string | null;
  unit: Unit | null;
  saleCondition: SaleCondition;
  universeCode: string | null;
  categoryCode: string | null;
  supplierCode: string | null;
  supplierRef: string | null;
  qualities: Quality[];
  vatRate: string;
  status: ProductStatus;
  purchasePriceExcl: string | null;
  purchasePriceIncl: string | null;
  salePrice: string;
  stock: string;
  minStock: string | null;
  labelPending: boolean;
  createdOn: string | null;
  ean: string | null;
}

const VAT = new Set(['0.00', '5.50', '10.00', '20.00']);
/** Legacy-only services replaced by v2 features (wallet top-up and debit). */
export const RETIRED_SERVICES = new Set(['01010', '01011']);

export function transformProduct(r: LegacyProductRow): { draft: ProductDraft; issues: Issue[] } {
  const issues: Issue[] = [];
  const code = r.PRODNUM.trim();
  const issue = (field: string, value: unknown, problem: string, action: string) =>
    issues.push({
      entity: 'produit',
      legacyId: code,
      field,
      value: String(value ?? ''),
      problem,
      action,
    });

  // Codes 01xxx are services (R-PRD-02).
  const kind: ProductKind = code.length === 5 && code.startsWith('01') ? 'SERVICE' : 'GOODS';

  let saleMode = SALE_MODE_BY_CODE[r.PRODTYPVTE ?? -1];
  if (!saleMode) {
    issue('PRODTYPVTE', r.PRODTYPVTE, 'type de vente invalide', 'à l’unité');
    saleMode = 'UNIT';
  }
  let unit: Unit | null = UNIT_BY_CODE[r.PRODUNITVTE ?? -1] ?? null;
  if (!unit && kind === 'GOODS' && r.PRODUNITVTE !== null) {
    issue('PRODUNITVTE', r.PRODUNITVTE, 'unité invalide', 'unité laissée vide');
    unit = null;
  }
  const saleCondition = CONDITION_BY_CODE[r.PRODCONDVTE ?? -1] ?? 'ON_SITE';
  let status = STATUS_BY_CODE[r.PRODSTATUT ?? -1];
  if (!status) {
    issue('PRODSTATUT', r.PRODSTATUT, 'statut invalide', 'inactif');
    status = 'INACTIVE';
  }
  if (RETIRED_SERVICES.has(code)) status = 'INACTIVE';

  let vatRate = fixed(r.PRODTVATX, 2) ?? '0.00';
  if (!VAT.has(vatRate)) {
    issue('PRODTVATX', r.PRODTVATX, 'taux de TVA hors liste', 'taux 0 %');
    vatRate = '0.00';
  }

  let ean: string | null = cleanText(r.PRODEAN13);
  // 64 products carry their own code in the EAN field: the till already finds them by code.
  if (ean === code) ean = null;
  if (ean && !isValidEan(ean)) {
    issue('PRODEAN13', ean, 'code-barres invalide (clé de contrôle ou longueur)', 'non repris');
    ean = null;
  }

  const salePrice = fixed(r.PRODPRIXVTE, 2) ?? '0.00';
  if (salePrice.startsWith('-')) issue('PRODPRIXVTE', salePrice, 'prix de vente négatif', 'prix 0');

  const universeCode = kind === 'SERVICE' ? null : cleanText(r.PRODUNIV);
  const categoryCode = kind === 'SERVICE' ? null : cleanText(r.PRODRAY);
  if (
    kind === 'GOODS' &&
    universeCode &&
    categoryCode &&
    !code.startsWith(`${universeCode}${categoryCode.padStart(2, '0')}`)
  ) {
    issue(
      'PRODNUM',
      code,
      `code incohérent avec l’univers ${universeCode} et le rayon ${categoryCode}`,
      'repris tel quel',
    );
  }

  return {
    draft: {
      code,
      name: cleanText(r.PRODNOM) ?? `Produit ${code}`,
      description: cleanText(r.PRODESCR),
      kind,
      saleMode,
      unitQty: fixed(r.PRODQTE, 3),
      unit,
      saleCondition,
      universeCode,
      categoryCode,
      supplierCode: cleanText(r.PRODFNR),
      supplierRef: cleanText(r.PRODREFFNR),
      qualities: parseQualities(r.PRODQUALITE),
      vatRate,
      status,
      purchasePriceExcl: fixed(r.PRODPAHT, 4),
      purchasePriceIncl: fixed(r.PRODPATTC, 4),
      salePrice: salePrice.startsWith('-') ? '0.00' : salePrice,
      stock: kind === 'SERVICE' ? '0.000' : (fixed(r.PRODSTOCK, 3) ?? '0.000'),
      minStock: fixed(r.PRODSTKMIN, 3),
      labelPending: (r.PRODPACHG ?? 0) !== 0,
      createdOn: r.PRODATCREA && r.PRODATCREA >= '1900-01-01' ? r.PRODATCREA : null,
      ean,
    },
    issues,
  };
}

// --- Payments (adhpayements, spec §6.3) ---------------------------------------------

const METHOD_BY_PAYMOD: PaymentMethod[] = ['CASH', 'CHEQUE', 'CARD', 'TRANSFER'];

export interface LegacyPaymentRow {
  PAYID: number;
  PAYADHID: number;
  PAYDATE: string;
  PAYMNT: string;
  PAYMOTIF: string;
  PAYMOD: number;
}

export type PaymentPlan =
  | {
      kind: 'payment';
      purpose: 'MEMBERSHIP' | 'DONATION' | 'OTHER';
      method: PaymentMethod | null;
      amount: string;
    }
  | { kind: 'topup'; method: PaymentMethod | null; amount: string }
  | { kind: 'wallet'; walletKind: 'PURCHASE' | 'CORRECTION'; amount: string; comment: string };

/**
 * 01001/01002 → MEMBERSHIP, 01004 → DONATION, 01003 → OTHER, 01010 → TOPUP + cagnotte,
 * 01011 → cagnotte PURCHASE only. PAYMOD 3 is also used for cagnotte debits.
 */
export function planPayment(
  r: LegacyPaymentRow,
  today: string,
): { plan: PaymentPlan | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const issue = (field: string, value: unknown, problem: string, action: string) =>
    issues.push({
      entity: 'paiement',
      legacyId: String(r.PAYID),
      field,
      value: String(value ?? ''),
      problem,
      action,
    });
  const cents = legacyCents(r.PAYMNT);
  const amount = centsToDecimal(cents);
  if (r.PAYDATE > today) issue('PAYDATE', r.PAYDATE, 'date dans le futur', 'reprise telle quelle');
  const motif = r.PAYMOTIF.trim();
  let method: PaymentMethod | null = METHOD_BY_PAYMOD[r.PAYMOD] ?? null;
  if (cents === 0) {
    issue('PAYMNT', r.PAYMNT, 'montant nul', 'non repris');
    return { plan: null, issues };
  }
  if (motif === '01011') {
    return {
      plan:
        cents < 0
          ? {
              kind: 'wallet',
              walletKind: 'PURCHASE',
              amount,
              comment: 'Débit des achats (reprise EpiSoft)',
            }
          : {
              kind: 'wallet',
              walletKind: 'CORRECTION',
              amount,
              comment: 'Débit positif (reprise EpiSoft)',
            },
      issues,
    };
  }
  if (!method) {
    issue('PAYMOD', r.PAYMOD, 'mode de paiement inconnu', 'mode laissé vide');
    method = null;
  }
  if (motif === '01010') {
    if (cents < 0) {
      issue('PAYMNT', amount, 'versement négatif (retrait de cagnotte)', 'correction de cagnotte');
      return {
        plan: {
          kind: 'wallet',
          walletKind: 'CORRECTION',
          amount,
          comment: 'Retrait (reprise EpiSoft)',
        },
        issues,
      };
    }
    return { plan: { kind: 'topup', method, amount }, issues };
  }
  const purpose =
    motif === '01001' || motif === '01002'
      ? 'MEMBERSHIP'
      : motif === '01004'
        ? 'DONATION'
        : 'OTHER';
  if (!['01001', '01002', '01003', '01004'].includes(motif))
    issue('PAYMOTIF', motif, 'motif inconnu', 'autre');
  return { plan: { kind: 'payment', purpose, method, amount }, issues };
}

// --- Tickets ---------------------------------------------------------------------------

const TICKET_METHODS: PaymentMethod[] = ['CASH', 'CHEQUE', 'CARD', 'WALLET'];

/** `TICKMODPAY` = "esp|chq|cb|cag" → non-zero payments (spec §6.3). */
export function parseTicketPayments(
  modpay: string,
): { method: PaymentMethod; cents: number }[] | null {
  const parts = modpay.split('|');
  if (parts.length !== 4 || parts.some((p) => !/^-?\d+(\.\d+)?$/.test(p.trim()))) return null;
  return parts
    .map((p, i) => ({ method: TICKET_METHODS[i]!, cents: legacyCents(p) }))
    .filter((p) => p.cents !== 0);
}

/**
 * Legacy debits ("01011") are written by EpiSoft at closing and do not always match the tickets
 * (days never debited, double debits, shifted days). From the first migrated ticket on, the
 * cagnotte is therefore debited from the tickets themselves, and the negative legacy debits of
 * that period are not imported (R-CAG-02, §9.1 step 3). Positive "debits" stay: they are
 * manual corrections with no ticket behind them.
 */
export function isDebitCoveredByTickets(
  plan: { kind: string; walletKind?: string } | null,
  paymentDate: string,
  firstTicketDate: string | null,
): boolean {
  return (
    !!firstTicketDate &&
    plan?.kind === 'wallet' &&
    plan.walletKind === 'PURCHASE' &&
    paymentDate.slice(0, 10) >= firstTicketDate.slice(0, 10)
  );
}

/**
 * First day of the ticket history that is really in use: stray old tickets (tests, a year
 * restart) are ignored by starting after the last gap longer than `maxGapDays`.
 * `days` are YYYY-MM-DD strings, in any order, duplicates allowed.
 */
export function firstContinuousTicketDate(days: readonly string[], maxGapDays = 31): string | null {
  const sorted = [...new Set(days.map((d) => d.slice(0, 10)))].sort();
  if (!sorted.length) return null;
  let start = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (Date.parse(sorted[i]!) - Date.parse(sorted[i - 1]!)) / 86_400_000;
    if (gap > maxGapDays) start = sorted[i]!;
  }
  return start;
}
