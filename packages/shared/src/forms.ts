import { z } from 'zod';
import { MEMBER_STATUSES } from './api';
import { parsePrice4, price4ToDecimal } from './supplies';
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
import { patchOf } from './patch';
import { foodInfoFields, foodInfoProblems } from './compliance';
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

/** A town added to the reference list (members and suppliers pick their commune from it). */
export const communeCreateSchema = z.object({
  postcode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'Code postal à 5 chiffres.'),
  name: z.string().trim().min(1, 'Nom de la commune requis.').max(100),
});

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
  /** R-EVO-40: no ticket e-mail after a sale or a top-up. */
  ticketEmailOptOut: z.boolean().default(false),
  /** R-EVO-44: agrees to the use of their image (dated when given). */
  imageConsent: z.boolean().default(false),
  username: text(100).refine(
    (s) => s === null || /^[\p{L}0-9_.-]+$/u.test(s),
    'Lettres, chiffres, _ . - seulement.',
  ),
};

export const memberCreateSchema = z.object({
  ...memberFields,
  /** Existing household, or null to create a new one with this member as referent (R-MBR-02). */
  householdId: z.string().uuid().nullable(),
  /**
   * RGPD art. 13: the person was told how their data are used (the privacy policy). Recorded as a
   * dated consent record; a card is not created without it.
   */
  privacyNoticeGiven: z.boolean().default(false),
});
export type MemberCreate = z.input<typeof memberCreateSchema>;

/** R-MBR-09: only the fields present are changed. `updatedAt` guards against lost updates (§8.1). */
export const memberPatchSchema = patchOf({
  ...memberFields,
  householdId: z.string().uuid(),
}).extend({ updatedAt: z.string().datetime({ offset: true }) });
export type MemberPatch = z.input<typeof memberPatchSchema>;

export const householdPatchSchema = patchOf({
  notes: text(2000),
  transferReference: text(100),
  referentMemberId: z.string().uuid(),
}).extend({ updatedAt: z.string().datetime({ offset: true }) });

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

/** A purchase amount typed by hand, up to 4 decimals, kept as typed (no calculation). */
const purchaseAmountInput = z
  .string()
  .trim()
  .refine((s) => {
    const p = parsePrice4(s);
    return p !== null && p >= 0;
  }, 'Montant invalide (4 décimales au plus).')
  .transform((s) => price4ToDecimal(parsePrice4(s)!));

/**
 * Consistency of the three purchase amounts typed on a product sheet (R-PRD-04). They stay free
 * fields, but an impossible combination is refused: PA TTC below PA HT, a VAT above the highest
 * French rate (20 % of the PA HT), or, when the three are given, a PA TTC that is not PA HT plus
 * the VAT amount. Empty fields are not checked.
 */
export function purchasePricesProblem(prices: {
  purchasePriceExcl?: string | null;
  purchaseVatAmount?: string | null;
  purchasePriceIncl?: string | null;
}): string | null {
  const excl = prices.purchasePriceExcl ? parsePrice4(prices.purchasePriceExcl) : null;
  const vat = prices.purchaseVatAmount ? parsePrice4(prices.purchaseVatAmount) : null;
  const incl = prices.purchasePriceIncl ? parsePrice4(prices.purchasePriceIncl) : null;
  if (excl !== null && incl !== null && incl < excl)
    return 'Le PA TTC ne peut pas être inférieur au PA HT.';
  if (excl !== null && vat !== null && vat * 5 > excl + 5)
    return 'Le montant de TVA dépasse 20 % du PA HT : vérifiez les montants.';
  if (excl !== null && vat !== null && incl !== null && excl + vat !== incl)
    return 'Le PA TTC doit être égal au PA HT plus le montant de TVA.';
  return null;
}

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
  // R-PRD-04: PA HT, VAT amount and PA TTC are three free fields. Nothing is computed from
  // another; their consistency is checked by purchasePricesProblem.
  purchasePriceExcl: purchaseAmountInput.nullable(),
  purchaseVatAmount: purchaseAmountInput.nullable().optional(),
  purchasePriceIncl: purchaseAmountInput.nullable().optional(),
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
  // Food information, allergens, origin and claims (règlement UE 1169/2011): see compliance.ts.
  ...foodInfoFields,
};

export const productCreateSchema = z
  .object({
    ...productFields,
    /** Proposed by the server from the shelf (R-PRD-01) when omitted. */
    code: z
      .string()
      .trim()
      .regex(/^\d{5,6}$/, 'Code à 5 ou 6 chiffres.')
      .optional(),
  })
  .superRefine((v, ctx) => {
    const problem = purchasePricesProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', path: ['purchasePriceIncl'], message: problem });
    for (const f of foodInfoProblems(v))
      ctx.addIssue({ code: 'custom', path: [f.path], message: f.message });
  });
export type ProductCreate = z.input<typeof productCreateSchema>;

export const productPatchSchema = patchOf({
  ...productFields,
  code: z
    .string()
    .trim()
    .regex(/^\d{5,6}$/, 'Code à 5 ou 6 chiffres.'),
}).extend({ updatedAt: z.string().datetime({ offset: true }) });
export type ProductPatch = z.input<typeof productPatchSchema>;

/**
 * Suggestion only (back-fill of old rows, bulk grid): PA TTC = PA HT × (1 + TVA), to 4
 * decimals. The product form never calls it (R-PRD-04).
 */
export function purchasePriceIncl(excl: string, vatRate: string): string {
  const exclMilliCents = Math.round(Number(excl) * 10_000);
  const rateBp = Math.round(Number(vatRate) * 100);
  const incl = Math.round((exclMilliCents * (10_000 + rateBp)) / 10_000);
  return (incl / 10_000).toFixed(4);
}
