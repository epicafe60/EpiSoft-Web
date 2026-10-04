import { z } from 'zod';
import { VAT_RATES } from './catalog';
import { amountInput } from './forms';
import { isValidEmail } from './text';
import { milliToDecimal, parseQtyToMilli } from './pos';
import { parsePrice4, price4ToDecimal } from './supplies';

// Lot 2 forms (suppliers, orders, receipts, stock, inventory, invoices).

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide.');

/** Positive quantity with up to 3 decimals, normalised to "1.500". */
export const qtyInput = z
  .string()
  .trim()
  .refine((s) => parseQtyToMilli(s) !== null, 'Quantité invalide (3 décimales au plus).')
  .transform((s) => milliToDecimal(parseQtyToMilli(s)!));

const positiveQty = qtyInput.refine(
  (s) => !s.startsWith('-') && s !== '0.000',
  'La quantité doit être positive.',
);
const signedQty = qtyInput.refine(
  (s) => s !== '0.000' && s !== '-0.000',
  'La quantité ne peut pas être nulle.',
);

/** Purchase price with up to 4 decimals, normalised to "1.2345". */
export const price4Input = z
  .string()
  .trim()
  .refine((s) => {
    const p = parsePrice4(s);
    return p !== null && p >= 0;
  }, 'Prix invalide (4 décimales au plus).')
  .transform((s) => price4ToDecimal(parsePrice4(s)!));

// --- Suppliers (R-FNR-01, R-FNR-02: only the name is required) ---------------------------

export const supplierSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{3,8}$/, 'Code numérique (région + séquence).')
    .optional(),
  region: z
    .string()
    .trim()
    .regex(/^\d{1,2}$/)
    .optional(),
  name: z.string().trim().min(1, 'Nom requis.').max(200),
  contact: text(200),
  street: text(200),
  postcode: text(5),
  communeId: z.string().uuid().nullable(),
  phone: text(30),
  email: text(200).refine((s) => s === null || isValidEmail(s), 'Courriel invalide.'),
  website: text(300),
  priceListUrl: text(300),
  active: z.boolean(),
  publicNotes: text(2000),
  privateNotes: text(2000),
  referentMemberId: z.string().uuid().nullable(),
  sendsPo: z.boolean(),
  accountNumber: text(10),
  minOrderAmount: amountInput.nullable(),
  paymentTermsDays: z.number().int().min(0).max(180),
  deliveryDay: text(30),
});
export type SupplierInput = z.input<typeof supplierSchema>;

// --- Purchase orders (R-CMD-01/02/07) ------------------------------------------------------

export const orderLineSchema = z.object({
  productId: z.string().uuid(),
  qty: qtyInput,
  unitPriceExcl: price4Input,
});

export const orderSchema = z.object({
  date: isoDate.optional(),
  comment: text(1000).optional(),
  /** R-CMD-02: a line with quantity 0 is removed. */
  lines: z.array(orderLineSchema).max(500),
});

export const orderCreateSchema = z.object({
  supplierId: z.string().uuid(),
  date: isoDate.optional(),
  comment: text(1000).optional(),
  /** Omitted: prefilled with the supplier's active products and suggested quantities. */
  lines: z.array(orderLineSchema).max(500).optional(),
});

export const orderSendSchema = z.object({
  to: z.string().trim().refine(isValidEmail, 'Courriel invalide.'),
  subject: z.string().trim().min(1).max(200),
  message: z.string().max(5000),
});

// --- Receipts (R-CMD-05/06) ----------------------------------------------------------------

export const receiptSchema = z.object({
  date: isoDate.optional(),
  comment: text(1000).optional(),
  lines: z
    .array(
      z.object({
        /** The order line received, or null for a product that was not ordered. */
        orderLineId: z.string().uuid().nullable(),
        productId: z.string().uuid(),
        qty: positiveQty,
        unitPriceExcl: price4Input,
        /** R-STK-07: best-before date of the received batch, tracked on the stock page. */
        bestBefore: isoDate.nullish(),
      }),
    )
    .min(1, 'Aucune quantité reçue.')
    .max(500),
  /** R-CMD-06: close the order even if some quantities are still expected. */
  closeOrder: z.boolean().default(false),
  /** R-CMD-05: new selling prices accepted on the receipt screen (product id → price). */
  newSalePrices: z.record(z.string().uuid(), amountInput).default({}),
});

// --- Stock (R-STK-03) and inventory (R-STK-04) ---------------------------------------------

export const lossSchema = z.object({
  productId: z.string().uuid(),
  qty: positiveQty,
  reason: z.string().trim().min(2, 'Indiquez le motif.').max(200),
});

export const correctionSchema = z.object({
  productId: z.string().uuid(),
  qty: signedQty,
  comment: z.string().trim().min(2, 'Indiquez le motif.').max(200),
});

export const inventoryCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  scope: z.object({
    supplierId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    productIds: z.array(z.string().uuid()).max(5000).optional(),
  }),
});

export const inventoryCountSchema = z.object({
  /** "add" accumulates successive counts of the same product; "set" replaces. */
  mode: z.enum(['add', 'set']),
  qty: qtyInput.refine((s) => !s.startsWith('-'), 'Quantité négative.'),
});

export const inventoryValidateSchema = z.object({
  zeroUncounted: z.boolean().default(false),
});

// --- Supplier invoices (R-FAC-01/02/04) ----------------------------------------------------

export const SUPPLIER_PAYMENT_METHODS = [
  'CASH',
  'CHEQUE',
  'CARD',
  'TRANSFER',
  'DIRECT_DEBIT',
] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];
export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  CASH: 'Espèces',
  CHEQUE: 'Chèque',
  CARD: 'Carte',
  TRANSFER: 'Virement',
  DIRECT_DEBIT: 'Prélèvement',
};

export const invoiceSchema = z.object({
  supplierId: z.string().uuid(),
  pieceRef: z.string().trim().min(1, 'N° de pièce requis.').max(60),
  date: isoDate,
  dueDate: isoDate.optional(),
  totalExcl: amountInput,
  /** R-FAC-01: the VAT may be 0. */
  totalVat: amountInput,
  paymentMethod: z.enum(SUPPLIER_PAYMENT_METHODS).nullable(),
  comment: text(500),
  receiptIds: z.array(z.string().uuid()).max(50).default([]),
});

export const invoicePaySchema = z.object({
  date: isoDate,
  method: z.enum(SUPPLIER_PAYMENT_METHODS),
});

// --- Catalogue administration (R-PRD-08, R-PRD-09) -------------------------------------------

export const universeSchema = z.object({
  code: z.string().trim().regex(/^\d$/, 'Un chiffre.'),
  name: z.string().trim().min(1).max(100),
  sort: z.number().int().min(0).max(999),
});

export const categorySchema = z.object({
  universeId: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^\d{2}$/, 'Deux chiffres.'),
  name: z.string().trim().min(1).max(100),
  sort: z.number().int().min(0).max(999),
  shopVisible: z.boolean().default(true),
});

export const bulkPricesSchema = z.object({
  rows: z
    .array(
      z.object({
        productId: z.string().uuid(),
        purchasePriceExcl: price4Input.nullable(),
        vatRate: z.enum(VAT_RATES),
        salePrice: amountInput,
        active: z.boolean(),
      }),
    )
    .min(1)
    .max(2000),
});

export const labelsSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(1000),
  perPage: z.union([z.literal(24), z.literal(40)]).optional(),
  markDone: z.boolean().default(false),
});

/** R-STK-07: a dated batch of a product (best-before date and quantity). */
export const batchSchema = z.object({
  productId: z.string().uuid(),
  bestBefore: isoDate,
  qty: positiveQty,
  note: text(200).optional(),
});
