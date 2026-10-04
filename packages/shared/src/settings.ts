import { z } from 'zod';
import { parseAmountToCents, centsToDecimal } from './money';
import { DEFAULT_ACCOUNTS } from './accounting';

// Settings editable in the app (spec §4.15 R-ADM-01). Each key has its own schema.
// Lot 0 covers the general settings; later lots add their keys here.

const amount = z
  .string()
  .trim()
  .refine((s) => parseAmountToCents(s) !== null, 'Montant invalide.')
  .transform((s) => centsToDecimal(parseAmountToCents(s)!));

const account = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Compte à 6 chiffres.');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable();

export const settingSchemas = {
  'association.identity': z.object({
    name: z.string().trim().min(1, 'Nom requis.').max(200),
    street: optionalText(200),
    postcode: optionalText(10),
    city: optionalText(100),
    siren: optionalText(9).refine(
      (s) => s === null || /^\d{9}$/.test(s),
      'Le SIREN comporte 9 chiffres.',
    ),
    rna: optionalText(10).refine(
      (s) => s === null || /^W\d{9}$/.test(s),
      'Le RNA est de la forme W123456789.',
    ),
    email: optionalText(200),
    phone: optionalText(30),
  }),
  'pos.defaultFloat': z.object({ amount }),
  // Q4 (open): default is no overdraft (0 €). Flagged in spec §11.3.
  'wallet.overdraftLimit': z.object({
    amount: amount.refine((s) => !s.startsWith('-'), 'Le découvert est un montant positif.'),
  }),
  'pos.sellToNonMembers': z.object({ enabled: z.boolean() }),
  'pos.options': z.object({
    /** R-VTE-09: transfer accepted as a payment method at the till. */
    allowTransfer: z.boolean(),
    /** R-VTE-07: line discounts allowed at the till. */
    discountsEnabled: z.boolean(),
    /** R-ADH-03: an expired membership blocks the sale instead of only warning. */
    membershipExpiredBlocking: z.boolean(),
  }),
  /** R-VTE-04: in-store scale labels (prefix 20–29, 5-digit PLU, 5-digit value). */
  'pos.scaleBarcodes': z.object({
    enabled: z.boolean(),
    valueKind: z.enum(['PRICE', 'WEIGHT']),
  }),
  /** R-ADH-04: e-mail reminder before a membership ends. */
  'membership.reminder': z.object({
    enabled: z.boolean(),
    daysBefore: z.number().int().min(1).max(60),
  }),
  /** R-PRD-03 (open question Q2): target markup rate on the selling price, and rounding. */
  'catalog.pricing': z.object({
    targetMarkupPct: z.number().min(0).max(95),
    rounding: z.union([z.literal(1), z.literal(5), z.literal(10)]),
  }),
  /** R-PRD-06: A4 label sheets. */
  'labels.layout': z.object({ perPage: z.union([z.literal(24), z.literal(40)]) }),
  /** R-ADM-01: the accounts used by the automatic entries (R-CPT-08..11). */
  'accounting.accounts': z.object({
    sales: account,
    purchases: account,
    cash: account,
    cheques: account,
    cards: account,
    bank: account,
    wallet: account,
    memberships: account,
    donations: account,
    otherIncome: account,
    cashShort: account,
    stock: account,
    stockVariation: account,
    surplus: account,
    deficit: account,
  }),
  /** R-SES-02 step 6: the closing report is sent to this address. */
  'pos.treasurerEmail': z.object({
    email: optionalText(200).refine(
      (s) => s === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
      'Courriel invalide.',
    ),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.output<(typeof settingSchemas)[K]>;
export type Settings = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

export const SETTING_DEFAULTS: Settings = {
  'association.identity': {
    name: 'Épicafé de Montjavoult',
    street: null,
    postcode: null,
    city: 'Montjavoult',
    siren: null,
    rna: null,
    email: null,
    phone: null,
  },
  'pos.defaultFloat': { amount: '0.00' },
  'wallet.overdraftLimit': { amount: '0.00' },
  'pos.sellToNonMembers': { enabled: true },
  'pos.options': {
    allowTransfer: false,
    discountsEnabled: false,
    membershipExpiredBlocking: false,
  },
  'pos.treasurerEmail': { email: null },
  'membership.reminder': { enabled: false, daysBefore: 15 },
  'accounting.accounts': { ...DEFAULT_ACCOUNTS },
  'catalog.pricing': { targetMarkupPct: 25, rounding: 5 },
  'labels.layout': { perPage: 24 },
  'pos.scaleBarcodes': { enabled: false, valueKind: 'PRICE' },
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingSchemas, key);
}
