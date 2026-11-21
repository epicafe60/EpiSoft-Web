import {
  centsToDecimal,
  cleanText,
  formatVatRate,
  INVOICE_LINE_VAT_TOLERANCE_CENTS,
  nearestStandardRate,
  parseAmountToCents,
  STANDARD_VAT_RATES,
  vatOfExclCents,
} from '@episoft/shared';
import type { Issue } from './transform';
import { legacyCents } from './transform-lot1';

// Pure legacy → v2 transforms for lot 2 (spec §6.3): orders, supplier invoices.

export type OrderStatus = 'DRAFT' | 'SENT' | 'RECEIVED';

/** FNRCOMSTATUS 0 waiting, 1 sent, 2 received, 3 processed (§6.3: 2 and 3 → RECEIVED). */
export function orderStatus(v: number | null): OrderStatus {
  if (v === 1) return 'SENT';
  if (v === 2 || v === 3) return 'RECEIVED';
  return 'DRAFT';
}

/** FDCOMPRTVA holds a VAT rate when it is one of the catalogue rates; else the product's. */
export function lineVatRate(legacy: number | null, productRate: string): string {
  const rate = legacy === null ? null : (Math.round(legacy * 100) / 100).toFixed(2);
  return rate && ['0.00', '5.50', '10.00', '20.00'].includes(rate) ? rate : productRate;
}

export interface LegacyInvoiceRow {
  FACTID: number;
  FACTFNR: string;
  FACTPIECE: string | null;
  FACTDATE: string;
  FACTHT: number | null;
  FACTTVA: number | null;
  FACTTTC: number | null;
  FACTECH: string | null;
  FACTETAT: number;
  FACTMODE: number;
  FACTLINK: string | null;
  FACTCOM: string | null;
}

export interface InvoiceDraft {
  pieceRef: string;
  date: string;
  dueDate: string;
  totalExcl: string;
  totalVat: string;
  totalIncl: string;
  status: 'TO_PAY' | 'PAID';
  paymentMethod: 'CHEQUE' | 'CARD' | 'TRANSFER' | 'DIRECT_DEBIT' | null;
  comment: string | null;
}

/**
 * FACTETAT 0 to pay, 1 paid, 2 posted (paid). FACTMODE is inconsistent in EpiSoft (§2.6.2):
 * 1 cheque, 2 card, 3 transfer, 4 direct debit are kept; 0 (cash or "none") is left empty.
 * Totals: TTC = HT + VAT is enforced (v2 constraint), the VAT taking the difference.
 */
export function transformInvoice(r: LegacyInvoiceRow): { draft: InvoiceDraft; issues: Issue[] } {
  const issues: Issue[] = [];
  const issue = (field: string, value: unknown, problem: string, action: string) =>
    issues.push({
      entity: 'facture',
      legacyId: String(r.FACTID),
      field,
      value: String(value ?? ''),
      problem,
      action,
    });

  const excl = legacyCents(r.FACTHT);
  let vat = legacyCents(r.FACTTVA);
  const incl = r.FACTTTC === null ? excl + vat : legacyCents(r.FACTTTC);
  if (excl + vat !== incl) {
    issue(
      'FACTTVA',
      `${r.FACTHT} + ${r.FACTTVA} ≠ ${r.FACTTTC}`,
      'HT + TVA différent du TTC',
      'TVA = TTC − HT',
    );
    vat = incl - excl;
  }
  let dueDate = r.FACTECH && r.FACTECH >= '2000-01-01' ? r.FACTECH : r.FACTDATE;
  if (dueDate < r.FACTDATE) {
    issue('FACTECH', r.FACTECH, 'échéance avant la date de facture', 'échéance = date de facture');
    dueDate = r.FACTDATE;
  }
  let pieceRef = cleanText(r.FACTPIECE);
  if (!pieceRef) {
    pieceRef = `SANS-REF-${r.FACTID}`;
    issue('FACTPIECE', '', 'n° de pièce vide', pieceRef);
  }
  const method =
    ({ 1: 'CHEQUE', 2: 'CARD', 3: 'TRANSFER', 4: 'DIRECT_DEBIT' } as const)[
      r.FACTMODE as 1 | 2 | 3 | 4
    ] ?? null;
  const status = r.FACTETAT === 0 ? 'TO_PAY' : 'PAID';
  if (status === 'PAID' && !method)
    issue(
      'FACTMODE',
      r.FACTMODE,
      'mode de règlement ambigu (espèces ou non renseigné)',
      'laissé vide',
    );
  const link = cleanText(r.FACTLINK);
  const comment =
    [cleanText(r.FACTCOM), link ? `Document EpiSoft : ${link}` : null]
      .filter(Boolean)
      .join(' — ') || null;
  return {
    draft: {
      pieceRef,
      date: r.FACTDATE,
      dueDate,
      totalExcl: centsToDecimal(excl),
      totalVat: centsToDecimal(vat),
      totalIncl: centsToDecimal(incl),
      status,
      paymentMethod: method,
      comment,
    },
    issues,
  };
}

// --- Breakdown of the VAT of an invoice (R-TVA-03) ---------------------------------------------

export interface InvoiceVatSplit {
  lines: { rate: string; excl: string; vat: string }[];
  /**
   * EXACT: one standard rate explains the VAT (or there is none). ESTIMATED: two standard rates
   * rebuilt from the totals. APPROXIMATE: the VAT does not fit any standard rate, the totals are
   * kept on the nearest one. NONE: no usable amount, no line.
   */
  quality: 'EXACT' | 'ESTIMATED' | 'APPROXIMATE' | 'NONE';
  note: string;
}

/**
 * The old software only had three totals per invoice; the new one enters invoices by VAT rate. The
 * breakdown is rebuilt from the totals: the real one is unknown, and the report says which invoices
 * were estimated so that the person who owns the accounts can check them.
 */
export function estimateInvoiceVatLines(exclDecimal: string, vatDecimal: string): InvoiceVatSplit {
  const excl = parseAmountToCents(exclDecimal) ?? 0;
  const vat = parseAmountToCents(vatDecimal) ?? 0;
  const dec = centsToDecimal;
  if (excl <= 0 || vat < 0)
    return { lines: [], quality: 'NONE', note: 'aucune ligne de TVA (HT nul ou négatif)' };
  if (vat === 0)
    return { lines: [{ rate: '0.00', excl: dec(excl), vat: '0.00' }], quality: 'EXACT', note: '' };
  const fits = (e: number, v: number, rate: string) =>
    Math.abs(v - vatOfExclCents(e, rate)) <= INVOICE_LINE_VAT_TOLERANCE_CENTS;

  const single = STANDARD_VAT_RATES.find((r) => fits(excl, vat, r));
  if (single)
    return {
      lines: [{ rate: single, excl: dec(excl), vat: dec(vat) }],
      quality: 'EXACT',
      note: '',
    };

  // Two standard rates around VAT / HT: HT1 + HT2 = HT and r1 HT1 + r2 HT2 = VAT.
  const pct = (vat / excl) * 100;
  for (let i = 0; i < STANDARD_VAT_RATES.length - 1; i++) {
    const r1 = STANDARD_VAT_RATES[i]!;
    const r2 = STANDARD_VAT_RATES[i + 1]!;
    if (!(pct > Number(r1) && pct < Number(r2))) continue;
    const excl2 = Math.round((vat - (excl * Number(r1)) / 100) / ((Number(r2) - Number(r1)) / 100));
    const excl1 = excl - excl2;
    if (excl1 <= 0 || excl2 <= 0) continue;
    const vat1 = vatOfExclCents(excl1, r1);
    const vat2 = vat - vat1;
    if (!fits(excl2, vat2, r2)) continue;
    return {
      lines: [
        { rate: r1, excl: dec(excl1), vat: dec(vat1) },
        { rate: r2, excl: dec(excl2), vat: dec(vat2) },
      ],
      quality: 'ESTIMATED',
      note: `ventilation estimée : ${formatVatRate(r1)} sur ${dec(excl1)} € et ${formatVatRate(r2)} sur ${dec(excl2)} € (à vérifier)`,
    };
  }
  const nearest = nearestStandardRate(excl, vat);
  return {
    lines: [{ rate: nearest, excl: dec(excl), vat: dec(vat) }],
    quality: 'APPROXIMATE',
    note: `la TVA ne correspond à aucun taux : totaux gardés sur ${formatVatRate(nearest)} (à vérifier)`,
  };
}
