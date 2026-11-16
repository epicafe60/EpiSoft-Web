import { z } from 'zod';
import { amountInput, positiveAmountInput } from './forms';
import { buildInvoiceEntry, reverseLines, type PlannedLine } from './accounting';

// Lot D: supplier credit notes (avoirs), cancelling an invoice, reversing a payment,
// approving and reopening a fiscal year.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide.');
const comment = z
  .string()
  .trim()
  .max(500)
  .transform((s) => (s === '' ? null : s))
  .nullable();

/** A reason is mandatory for every correction of the books (audit trail, art. L123-12 Code de commerce). */
export const reasonInput = z
  .string()
  .trim()
  .min(5, 'Indiquez le motif (5 caractères au moins).')
  .max(500);

export const creditNoteSchema = z.object({
  supplierId: z.string().uuid(),
  /** The invoice the credit note corrects; null for a standalone credit note (rebate, return). */
  invoiceId: z.string().uuid().nullable().default(null),
  pieceRef: z.string().trim().min(1, 'N° de pièce requis.').max(60),
  date: isoDate,
  totalExcl: positiveAmountInput,
  totalVat: amountInput.default('0.00'),
  /** Amount credited by the supplier, typed by the team. */
  totalIncl: positiveAmountInput,
  comment: comment.default(null),
});
export type CreditNoteInput = z.input<typeof creditNoteSchema>;

export const creditNoteApplySchema = z.object({
  invoiceId: z.string().uuid(),
  amount: positiveAmountInput,
  date: isoDate,
});

export const reasonSchema = z.object({ reason: reasonInput });

export const paymentReversalSchema = z.object({
  reason: reasonInput,
  date: isoDate.optional(),
});

export const fiscalYearReopenSchema = z.object({ reason: reasonInput });

export const fiscalYearApproveSchema = z.object({
  /** Date of the general assembly that approved the accounts. */
  date: isoDate,
  /** Reference of the minutes (procès-verbal) kept as proof. */
  reference: z.string().trim().min(3, 'Référence du procès-verbal requise.').max(200),
});

/**
 * A credit note cannot exceed what is left of the invoice it refers to (invoice total minus the
 * credit notes already recorded against it). Null when acceptable.
 */
export function creditNoteTooLargeProblem(a: {
  creditCents: number;
  invoiceCents: number;
  alreadyCreditedCents: number;
}): string | null {
  const room = a.invoiceCents - a.alreadyCreditedCents;
  if (a.creditCents <= room) return null;
  const f = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  return room <= 0
    ? 'Cette facture est déjà entièrement couverte par des avoirs.'
    : `L’avoir (${f(a.creditCents)} €) dépasse ce qui reste de la facture (${f(room)} €).`;
}

/** What is left of a credit note to offset: total minus the allocations. */
export const creditNoteRemainingCents = (totalCents: number, allocatedCents: number) =>
  totalCents - allocatedCents;

/**
 * Entry of a supplier credit note: the opposite of the invoice entry (401 debited, expense
 * credited), for the credit note's amount.
 */
export function buildCreditNoteEntry(a: {
  supplierAccount: string;
  expenseAccount: string;
  cents: number;
  label: string;
}): PlannedLine[] {
  return reverseLines(
    buildInvoiceEntry({
      supplierAccount: a.supplierAccount,
      expenseLines: [{ account: a.expenseAccount, cents: a.cents }],
      label: a.label,
    }),
  );
}
