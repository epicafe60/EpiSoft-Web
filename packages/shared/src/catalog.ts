// Catalogue, payment and ledger codes (spec §6.2) with their French labels.

export const PRODUCT_KINDS = ['GOODS', 'SERVICE'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];
export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  GOODS: 'Marchandise',
  SERVICE: 'Service',
};

export const SALE_MODES = ['UNIT', 'WEIGHT', 'VOLUME'] as const;
export type SaleMode = (typeof SALE_MODES)[number];
export const SALE_MODE_LABELS: Record<SaleMode, string> = {
  UNIT: 'À l’unité',
  WEIGHT: 'Au poids',
  VOLUME: 'Au volume',
};

export const UNITS = ['G', 'KG', 'ML', 'L'] as const;
export type Unit = (typeof UNITS)[number];
export const UNIT_LABELS: Record<Unit, string> = { G: 'g', KG: 'kg', ML: 'ml', L: 'L' };

export const SALE_CONDITIONS = ['ON_SITE', 'ON_ORDER', 'BOTH'] as const;
export type SaleCondition = (typeof SALE_CONDITIONS)[number];
export const SALE_CONDITION_LABELS: Record<SaleCondition, string> = {
  ON_SITE: 'Sur place',
  ON_ORDER: 'Sur commande',
  BOTH: 'Les deux',
};

export const PRODUCT_STATUSES = ['ON_ORDER', 'ACTIVE', 'INACTIVE', 'UNAVAILABLE'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  ON_ORDER: 'En commande',
  ACTIVE: 'Actif',
  INACTIVE: 'Inactif',
  UNAVAILABLE: 'Indisponible',
};

export const QUALITIES = ['LOCAL', 'ORGANIC', 'SEASONAL', 'STANDARD'] as const;
export type Quality = (typeof QUALITIES)[number];
export const QUALITY_LABELS: Record<Quality, string> = {
  LOCAL: 'Local',
  ORGANIC: 'Bio',
  SEASONAL: 'Saisonnier',
  STANDARD: 'Courant',
};

/** VAT rates allowed in the catalogue (§2.4.2). Q1: the association is presumed not liable. */
export const VAT_RATES = ['0.00', '5.50', '10.00', '20.00'] as const;

export const PRICE_SOURCES = ['FORM', 'RECEIPT', 'IMPORT', 'BULK', 'MIGRATION'] as const;

export const STOCK_MOVEMENT_KINDS = [
  'SALE',
  'SALE_CANCEL',
  'PURCHASE_IN',
  'SUPPLIER_RETURN',
  'INVENTORY',
  'LOSS',
  'CORRECTION',
  'INITIAL',
] as const;

export const MEMBER_PAYMENT_PURPOSES = ['MEMBERSHIP', 'TOPUP', 'DONATION', 'OTHER'] as const;
export type MemberPaymentPurpose = (typeof MEMBER_PAYMENT_PURPOSES)[number];
export const MEMBER_PAYMENT_PURPOSE_LABELS: Record<MemberPaymentPurpose, string> = {
  MEMBERSHIP: 'Adhésion',
  TOPUP: 'Versement cagnotte',
  DONATION: 'Don',
  OTHER: 'Autre',
};

/** Methods for payments made outside the till's sale screen (no WALLET). */
export const MEMBER_PAYMENT_METHODS = ['CASH', 'CHEQUE', 'CARD', 'TRANSFER'] as const;
export type MemberPaymentMethod = (typeof MEMBER_PAYMENT_METHODS)[number];

export const WALLET_ENTRY_KINDS = ['TOPUP', 'PURCHASE', 'REFUND', 'CORRECTION'] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];
export const WALLET_ENTRY_KIND_LABELS: Record<WalletEntryKind, string> = {
  TOPUP: 'Versement',
  PURCHASE: 'Achat',
  REFUND: 'Remboursement',
  CORRECTION: 'Correction',
};

/** Price per kg or per litre (R-PRD-04), in cents, or null when not applicable. */
export function pricePerKgOrLitreCents(
  salePriceCents: number,
  unitQtyMilli: number,
  unit: Unit | null,
): number | null {
  if (!unit || unitQtyMilli <= 0) return null;
  // unit_qty is expressed in the product unit: 155 g → 0.155 with unit KG, or 155 with unit G.
  const perUnit = (salePriceCents * 1000) / unitQtyMilli;
  return Math.round(unit === 'G' || unit === 'ML' ? perUnit * 1000 : perUnit);
}
