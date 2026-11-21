import { z } from 'zod';
import { pastOrTodayDate } from './dates';
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
import { purchaseVatProblem, vatOfExcl4 } from './vat';
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

/** Ceilings of a wallet movement: above them the entry is a typing mistake or needs a second person. */
export const MAX_TOPUP_CENTS = 100_000; // 1 000 €
export const MAX_CORRECTION_CENTS = 50_000; // 500 €
/** A correction above this amount (absolute value) must be made by an administrator. */
export const CORRECTION_ADMIN_THRESHOLD_CENTS = 10_000; // 100 €

const cents = (s: string) => Math.abs(parseAmountToCents(s) ?? 0);

export const walletTopupSchema = z.object({
  amount: positiveAmountInput.refine(
    (s) => cents(s) <= MAX_TOPUP_CENTS,
    'Montant trop élevé pour un rechargement (1 000 € au plus).',
  ),
  method: z.enum(MEMBER_PAYMENT_METHODS),
  date: pastOrTodayDate.optional(),
  comment: text(300).optional(),
  emailReceipt: z.boolean().default(true),
});

/** R-CAG-08: past top-ups are corrected by a CORRECTION entry, with a reason. */
export const walletCorrectionSchema = z.object({
  amount: amountInput
    .refine((s) => s !== '0.00', 'Le montant ne peut pas être nul.')
    .refine(
      (s) => cents(s) <= MAX_CORRECTION_CENTS,
      'Montant trop élevé pour une correction (500 € au plus).',
    ),
  comment: z.string().trim().min(3, 'Indiquez le motif.').max(300),
});

export const membershipCreateSchema = z.object({
  typeId: z.string().uuid(),
  method: z.enum(MEMBER_PAYMENT_METHODS),
  date: pastOrTodayDate.optional(),
  amount: amountInput.optional(),
  /** Required (and administrators only) when the amount differs from the price of the type. */
  reason: text(300).optional(),
});

export const membershipTypePatchSchema = z.object({
  label: z.string().trim().min(1).max(60),
  price: amountInput.refine(
    (s) => !s.startsWith('-') && cents(s) <= 100_000,
    'Tarif invalide (entre 0 et 1 000 €).',
  ),
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
 * Consistency of the three purchase amounts typed on a product sheet (R-PRD-04, R-TVA-02). They
 * stay typed fields, but an impossible combination is refused: PA TTC below PA HT, a VAT amount
 * that is not PA HT x the product's rate (one cent tolerance), or a PA TTC that is not PA HT plus
 * the VAT amount. Empty fields are not checked.
 */
export function purchasePricesProblem(prices: {
  purchasePriceExcl?: string | null;
  purchaseVatAmount?: string | null;
  purchasePriceIncl?: string | null;
  /** The VAT rate of the product ("5.50"): the VAT amount must be HT x rate (1 cent). */
  vatRate?: string | null;
}): string | null {
  return purchaseVatProblem({
    excl4: prices.purchasePriceExcl ? parsePrice4(prices.purchasePriceExcl) : null,
    vat4: prices.purchaseVatAmount ? parsePrice4(prices.purchaseVatAmount) : null,
    incl4: prices.purchasePriceIncl ? parsePrice4(prices.purchasePriceIncl) : null,
    rate: prices.vatRate ?? null,
  });
}

/**
 * Selling rules of a product sheet (art. L442-5 du Code de commerce: no resale at a loss). A
 * product may not be sold for nothing, nor below its purchase price excluding VAT, unless a reason
 * is given (perishable threatened with spoilage, end of series…): the exception is audited.
 * Returns the field at fault and the message, or null.
 */
export function salePriceProblem(p: {
  kind: string;
  salePrice: string;
  purchasePriceExcl?: string | null;
  vatRate: string;
  belowCostReason?: string | null;
}): { path: string; message: string } | null {
  const saleCents = parseAmountToCents(p.salePrice);
  if (saleCents === null) return null; // reported by the field itself
  if (p.kind === 'GOODS' && saleCents === 0)
    return {
      path: 'salePrice',
      message: 'Le prix de vente d’une marchandise ne peut pas être nul.',
    };
  const excl = p.purchasePriceExcl ? parsePrice4(p.purchasePriceExcl) : null;
  if (excl === null || excl === 0 || p.kind !== 'GOODS') return null;
  const rateBp = Math.round(Number(p.vatRate) * 100);
  const costInclCents = Math.floor((excl * (10_000 + rateBp)) / 10_000 / 100);
  if (saleCents < costInclCents && !p.belowCostReason)
    return {
      path: 'salePrice',
      message:
        'Le prix de vente est inférieur au prix d’achat HT : la revente à perte est interdite (art. L442-5 du Code de commerce). Si c’est une exception (produit périssable menacé, fin de série), indiquez le motif.',
    };
  return null;
}

/**
 * The three purchase amounts of a product sheet built from a PA HT received on a delivery, at the
 * VAT rate of the product (R-PRD-04): VAT = TTC - HT, TTC = HT x (1 + rate), to 4 decimals.
 * Null when the PA HT is not a valid price. The result always passes purchasePricesProblem.
 */
export function purchaseAmountsFromExcl(
  excl: string,
  vatRate: string,
): { purchasePriceExcl: string; purchaseVatAmount: string; purchasePriceIncl: string } | null {
  const excl4 = parsePrice4(excl);
  if (excl4 === null || excl4 < 0) return null;
  // R-TVA-02: the VAT amount comes from the single VAT calculation (vat.ts).
  const vat4 = vatOfExcl4(excl4, vatRate);
  return {
    purchasePriceExcl: price4ToDecimal(excl4),
    purchaseVatAmount: price4ToDecimal(vat4),
    purchasePriceIncl: price4ToDecimal(excl4 + vat4),
  };
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
  /** Reason of an explicit, audited exception to the ban on selling below the purchase price. */
  belowCostReason: text(300).optional(),
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
    for (const f of foodInfoProblems(v, { foodInfo: false }))
      ctx.addIssue({ code: 'custom', path: [f.path], message: f.message });
    const sale = salePriceProblem(v);
    if (sale) ctx.addIssue({ code: 'custom', path: [sale.path], message: sale.message });
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
