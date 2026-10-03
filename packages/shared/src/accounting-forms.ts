import { z } from 'zod';
import { RULE_MATCH_TYPES } from './bank';
import { amountInput } from './forms';

// Accounting forms (spec §4.11), shared by the API and the web screens.

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide.');

export const ENTRY_MODES = ['CASH', 'CHEQUE', 'CARD', 'TRANSFER', 'DIRECT_DEBIT', 'OTHER'] as const;
export type EntryModeCode = (typeof ENTRY_MODES)[number];
export const ENTRY_MODE_LABELS: Record<EntryModeCode, string> = {
  CASH: 'Espèces',
  CHEQUE: 'Chèque',
  CARD: 'Carte',
  TRANSFER: 'Virement',
  DIRECT_DEBIT: 'Prélèvement',
  OTHER: 'Autre',
};

/** Legacy MVTRGLT 0–5 → mode (§C of the specification). */
export const entryModeFromLegacy = (v: number | null): EntryModeCode | null =>
  ENTRY_MODES[v ?? -1] ?? null;

/** An amount typed in the form: empty means zero. */
const optionalAmount = z
  .string()
  .trim()
  .default('')
  .transform((s) => (s === '' ? '0' : s))
  .pipe(amountInput);

export const accountSchema = z.object({
  number: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Numéro à 6 chiffres.'),
  label: z.string().trim().min(1, 'Libellé requis.').max(120),
  normalSide: z.enum(['D', 'C', 'M']),
  active: z.boolean(),
});

export const journalSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,5}$/, '5 caractères au plus.'),
  label: z.string().trim().min(1).max(60),
  active: z.boolean(),
});

export const fiscalYearSchema = z
  .object({ label: z.string().trim().min(1).max(60), startDate: isoDate, endDate: isoDate })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'La fin précède le début.',
    path: ['endDate'],
  });

export const entryLineSchema = z.object({
  accountId: z.string().uuid('Choisissez un compte.'),
  label: z.string().trim().max(200).default(''),
  debit: optionalAmount,
  credit: optionalAmount,
});

export const entryInputSchema = z.object({
  journalId: z.string().uuid(),
  date: isoDate,
  pieceRef: text(60),
  label: z.string().trim().min(1, 'Libellé requis.').max(200),
  mode: z.enum(ENTRY_MODES).nullable(),
  lines: z.array(entryLineSchema).max(100),
});
export type EntryInput = z.input<typeof entryInputSchema>;

export const validateEntriesSchema = z.object({
  ids: z.array(z.string().uuid()).max(2000).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  journalId: z.string().uuid().optional(),
});

export const reverseSchema = z.object({
  date: isoDate.optional(),
  label: z.string().trim().max(200).optional(),
});

export const templateSchema = z.object({
  categoryCode: z.string().trim().max(10).nullable(),
  journalId: z.string().uuid(),
  label: z.string().trim().min(1).max(100),
  mode: z.enum(ENTRY_MODES).nullable(),
  active: z.boolean(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        label: z.string().trim().max(200).default(''),
        /** Fixed amount, or empty to enter at use. */
        debit: z
          .string()
          .trim()
          .default('')
          .transform((s) => (s === '' ? null : s))
          .pipe(amountInput.nullable()),
        credit: z
          .string()
          .trim()
          .default('')
          .transform((s) => (s === '' ? null : s))
          .pipe(amountInput.nullable()),
      }),
    )
    .min(2, 'Un guide comporte au moins deux lignes.')
    .max(50),
});

export const bankAccountSchema = z.object({
  label: z.string().trim().min(1).max(80),
  iban: text(40),
  accountId: z.string().uuid(),
  active: z.boolean(),
});

export const bankRuleSchema = z
  .object({
    priority: z.number().int().min(1).max(10_000),
    label: z.string().trim().min(1).max(100),
    pattern: z.string().trim().min(1, 'Motif requis.').max(200),
    matchType: z.enum(RULE_MATCH_TYPES),
    direction: z.enum(['IN', 'OUT', 'ANY']),
    minAmount: amountInput.nullable(),
    maxAmount: amountInput.nullable(),
    counterAccountId: z.string().uuid().nullable(),
    journalId: z.string().uuid().nullable(),
    mode: z.enum(ENTRY_MODES).nullable(),
    labelTemplate: text(200),
    householdMatch: z.boolean(),
    supplierId: z.string().uuid().nullable(),
    active: z.boolean(),
  })
  .refine((r) => r.householdMatch || r.counterAccountId || r.supplierId, {
    message: 'Indiquez un compte de contrepartie, un fournisseur ou le rapprochement des foyers.',
    path: ['counterAccountId'],
  });

export const bankImportQuerySchema = z.object({
  bankAccountId: z.string().uuid(),
  /** For formats that carry no balance (CSV): the statement balances typed by the user. */
  openingBalance: amountInput.optional(),
  closingBalance: amountInput.optional(),
});

export const BANK_MATCH_ACTIONS = [
  'ENTRY_LINE',
  'INVOICE',
  'HOUSEHOLD',
  'RULE',
  'ACCOUNT',
] as const;

export const bankMatchSchema = z.object({
  items: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        action: z.enum(BANK_MATCH_ACTIONS),
        entryLineId: z.string().uuid().optional(),
        invoiceId: z.string().uuid().optional(),
        householdId: z.string().uuid().optional(),
        ruleId: z.string().uuid().optional(),
        accountId: z.string().uuid().optional(),
        label: z.string().trim().max(200).optional(),
        sendReceipt: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const depositSchema = z.object({
  date: isoDate,
  kind: z.enum(['CASH', 'CHEQUES']),
  amount: amountInput,
  bankAccountId: z.string().uuid(),
  cheques: z
    .array(
      z.object({
        drawer: z.string().trim().max(100).default(''),
        bank: z.string().trim().max(60).default(''),
        amount: amountInput,
      }),
    )
    .max(200)
    .default([]),
  comment: text(300),
});

export const closingSchema = z.object({
  /** Valued inventory at the end of the year; omitted: the stock ledger valuation (R-STK-06). */
  stockValue: amountInput.optional(),
  confirm: z.literal(true),
});

export const reportQuerySchema = z.object({
  fiscalYearId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  journalId: z.string().uuid().optional(),
  accountFrom: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
  accountTo: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
  status: z.enum(['ALL', 'VALIDATED']).default('ALL'),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;
