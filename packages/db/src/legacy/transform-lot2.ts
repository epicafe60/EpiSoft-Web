import { centsToDecimal, cleanText } from '@episoft/shared';
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
