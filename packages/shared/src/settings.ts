import { z } from 'zod';
import { parseAmountToCents, centsToDecimal } from './money';

// Settings editable in the app (spec §4.15 R-ADM-01). Each key has its own schema.
// Lot 0 covers the general settings; later lots add their keys here.

const amount = z
  .string()
  .trim()
  .refine((s) => parseAmountToCents(s) !== null, 'Montant invalide.')
  .transform((s) => centsToDecimal(parseAmountToCents(s)!));

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
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingSchemas, key);
}
