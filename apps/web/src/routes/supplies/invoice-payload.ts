import type { SupplierPaymentMethod } from '@episoft/shared';

// What the supplier invoice form sends. Pure, so it is tested against the shared schema.

export interface InvoiceFormValues {
  supplierId: string;
  pieceRef: string;
  date: string;
  dueDate: string;
  totalExcl: string;
  totalVat: string;
  method: SupplierPaymentMethod | '';
  comment: string;
  receiptIds: string[];
}

export function invoicePayload(v: InvoiceFormValues) {
  return {
    supplierId: v.supplierId,
    pieceRef: v.pieceRef,
    date: v.date,
    dueDate: v.dueDate || undefined,
    totalExcl: v.totalExcl,
    totalVat: v.totalVat || '0',
    paymentMethod: v.method || null,
    comment: v.comment,
    receiptIds: v.receiptIds,
  };
}
