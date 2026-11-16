import type { SupplierPaymentMethod } from '@episoft/shared';

// What the supplier invoice form sends. Pure, so it is tested against the shared schema.

export interface InvoiceLineValues {
  rate: string;
  excl: string;
  vat: string;
}

export interface InvoiceFormValues {
  supplierId: string;
  pieceRef: string;
  date: string;
  dueDate: string;
  /** R-TVA-03: one line per VAT rate. Blank lines are ignored. */
  lines: InvoiceLineValues[];
  /** Total TTC alone, for a regime other than LIABLE (no breakdown). */
  totalIncl: string;
  method: SupplierPaymentMethod | '';
  comment: string;
  receiptIds: string[];
}

const blank = (l: InvoiceLineValues) => !l.excl.trim() && !l.vat.trim();

export function invoicePayload(v: InvoiceFormValues) {
  const vatLines = v.lines.filter((l) => !blank(l)).map((l) => ({ ...l, vat: l.vat || '0' }));
  return {
    supplierId: v.supplierId,
    pieceRef: v.pieceRef,
    date: v.date,
    dueDate: v.dueDate || undefined,
    vatLines,
    // Only without a breakdown: with one, the total is its sum.
    totalIncl: vatLines.length === 0 && v.totalIncl.trim() ? v.totalIncl : undefined,
    paymentMethod: v.method || null,
    comment: v.comment,
    receiptIds: v.receiptIds,
  };
}
