import { z } from 'zod';
import { MEMBER_STATUSES } from './api';
import {
  MEMBER_PAYMENT_METHODS,
  PRODUCT_KINDS,
  PRODUCT_STATUSES,
  QUALITIES,
  SALE_CONDITIONS,
  SALE_MODES,
  UNITS,
  VAT_RATES,
} from './catalog';
import { centsToDecimal, parseAmountToCents } from './money';
import { isValidEan, parseQtyToMilli, milliToDecimal } from './pos';
import { isValidEmail } from './text';

// Back-office forms (members, households, catalogue). Shared by the web forms and the API.

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s.replace(/\s+/g, ' ')))
    .nullable();

/** Amount typed with a comma or a dot, normalised to "12.50". */
export const amountInput = z
  .string()
  .trim()
  .refine((s) => parseAmountToCents(s) !== null, 'Montant invalide.')
  .transform((s) => centsToDecimal(parseAmountToCents(s)!));

export const positiveAmountInput = amountInput.refine(
  (s) => !s.startsWith('-') && s !== '0.00',
  'Le montant doit être positif.',
);

const qtyInput = z
  .string()
  .trim()
  .refine((s) => parseQtyToMilli(s) !== null, 'Quantité invalide (3 décimales au plus).')
  .transform((s) => milliToDecimal(parseQtyToMilli(s)!));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide.');

// --- Members (R-MBR-01, R-MBR-09) ---------------------------------------------------

export const memberFields = {
  lastName: z.string().trim().min(1, 'Nom requis.').max(100),
  firstName: z.string().trim().min(1, 'Prénom requis.').max(100),
  street: text(200),
  postcode: text(5).refine((s) => s === null || /^\d{5}$/.test(s), 'Code postal à 5 chiffres.'),
  communeId: z.string().uuid().nullable(),
  phone: text(30),
  email: text(200).refine((s) => s === null || isValidEmail(s), 'Courriel invalide.'),
  status: z.enum(MEMBER_STATUSES),
  publicVisible: z.boolean(),
  newsletter: z.boolean(),
  username: text(100).refine(
    (s) => s === null || /^[\p{L}0-9_.-]+$/u.test(s),
    'Lettres, chiffres, _ . - seulement.',
  ),
};

export const memberCreateSchema = z.object({
  ...memberFields,
  /** Existing household, or null to create a new one with this member as referent (R-MBR-02). */
  householdId: z.string().uuid().nullable(),
});
export type MemberCreate = z.input<typeof memberCreateSchema>;

/** R-MBR-09: only the fields present are changed. `updatedAt` guards against lost updates (§8.1). */
export const memberPatchSchema = z
  .object({ ...memberFields, householdId: z.string().uuid() })
  .partial()
  .extend({ updatedAt: z.string().datetime({ offset: true }) });
export type MemberPatch = z.input<typeof memberPatchSchema>;

export const householdPatchSchema = z
  .object({
    notes: text(2000),
    transferReference: text(100),
    referentMemberId: z.string().uuid(),
  })
  .partial()
  .extend({ updatedAt: z.string().datetime({ offset: true }) });

export const walletTopupSchema = z.object({
  amount: positiveAmountInput,
  method: z.enum(MEMBER_PAYMENT_METHODS),
  date: isoDate.optional(),
  comment: text(300).optional(),
  emailReceipt: z.boolean().default(true),
});

/** R-CAG-08: past top-ups are corrected by a CORRECTION entry, with a reason. */
export const walletCorrectionSchema = z.object({
  amount: amountInput.refine((s) => s !== '0.00', 'Le montant ne peut pas être nul.'),
  comment: z.string().trim().min(3, 'Indiquez le motif.').max(300),
});

export const membershipCreateSchema = z.object({
  typeId: z.string().uuid(),
  method: z.enum(MEMBER_PAYMENT_METHODS),
  date: isoDate.optional(),
  amount: amountInput.optional(),
});

export const membershipTypePatchSchema = z.object({
  label: z.string().trim().min(1).max(60),
  price: amountInput,
  durationMonths: z.number().int().min(0).max(60),
  active: z.boolean(),
});

// --- Products (R-PRD-01, simple form of lot 1) ----------------------------------------

export const productFields = {
  name: z.string().trim().min(1, 'Nom requis.').max(200),
  description: text(1000),
  kind: z.enum(PRODUCT_KINDS),
  saleMode: z.enum(SALE_MODES),
  unitQty: qtyInput.nullable(),
  unit: z.enum(UNITS).nullable(),
  saleCondition: z.enum(SALE_CONDITIONS),
  shopVisible: z.boolean().default(true),
  categoryId: z.string().uuid().nullable(),
  supplierId: z.string().uuid().nullable(),
  supplierRef: text(60),
  qualities: z.array(z.enum(QUALITIES)).max(QUALITIES.length),
  vatRate: z.enum(VAT_RATES),
  status: z.enum(PRODUCT_STATUSES),
  purchasePriceExcl: amountInput.nullable(),
  salePrice: amountInput.refine((s) => !s.startsWith('-'), 'Prix négatif.'),
  minStock: qtyInput.nullable(),
  eans: z
    .array(z.string().trim())
    .max(10)
    .refine((a) => a.every(isValidEan), 'Code-barres invalide (clé de contrôle EAN-13 ou EAN-8).')
    .refine((a) => new Set(a).size === a.length, 'Code-barres en double.'),
  posTabId: z.string().uuid().nullable(),
  posLabel: text(40),
  posSort: z.number().int().min(0).max(9999),
};

export const productCreateSchema = z.object({
  ...productFields,
  /** Proposed by the server from the shelf (R-PRD-01) when omitted. */
  code: z
    .string()
    .trim()
    .regex(/^\d{5,6}$/, 'Code à 5 ou 6 chiffres.')
    .optional(),
});
export type ProductCreate = z.input<typeof productCreateSchema>;

export const productPatchSchema = z
  .object({
    ...productFields,
    code: z
      .string()
      .trim()
      .regex(/^\d{5,6}$/, 'Code à 5 ou 6 chiffres.'),
  })
  .partial()
  .extend({ updatedAt: z.string().datetime({ offset: true }) });
export type ProductPatch = z.input<typeof productPatchSchema>;

/** R-PRD-04: PA TTC = PA HT × (1 + TVA), to 4 decimals. */
export function purchasePriceIncl(excl: string, vatRate: string): string {
  const exclMilliCents = Math.round(Number(excl) * 10_000);
  const rateBp = Math.round(Number(vatRate) * 100);
  const incl = Math.round((exclMilliCents * (10_000 + rateBp)) / 10_000);
  return (incl / 10_000).toFixed(4);
}
