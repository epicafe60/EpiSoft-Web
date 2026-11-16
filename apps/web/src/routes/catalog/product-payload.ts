import {
  withServiceSale,
  type Allergen,
  type AllergenDecision,
  type OriginFamily,
  type ProductCreate,
  type ProductKind,
  type ProductStatus,
  type Quality,
  type SaleCondition,
  type SaleMode,
  type Unit,
} from '@episoft/shared';
import type { ProductDetail } from '@/lib/types';

// What the product form holds (strings, as typed) and what it sends. Pure, so it is tested
// against the shared schema: a form that cannot produce a valid payload is a bug found here.

export interface ProductFormState {
  code: string;
  name: string;
  description: string;
  kind: ProductKind;
  saleMode: SaleMode;
  unitQty: string;
  unit: Unit | '';
  saleCondition: SaleCondition;
  shopVisible: boolean;
  categoryId: string;
  supplierId: string;
  supplierRef: string;
  qualities: Quality[];
  vatRate: string;
  status: ProductStatus;
  purchasePriceExcl: string;
  purchaseVatAmount: string;
  purchasePriceIncl: string;
  salePrice: string;
  minStock: string;
  eans: string;
  posTabId: string;
  posLabel: string;
  posSort: string;
  isFood: boolean;
  ingredients: string;
  allergensDecision: AllergenDecision | '';
  allergens: Allergen[];
  allergenTraces: Allergen[];
  origin: string;
  originFamily: OriginFamily | '';
  localJustification: string;
}

export const EMPTY_PRODUCT_FORM: ProductFormState = {
  code: '',
  name: '',
  description: '',
  kind: 'GOODS',
  saleMode: 'UNIT',
  unitQty: '',
  unit: '',
  saleCondition: 'ON_SITE',
  shopVisible: true,
  categoryId: '',
  supplierId: '',
  supplierRef: '',
  qualities: [],
  vatRate: '5.50',
  status: 'ACTIVE',
  purchasePriceExcl: '',
  purchaseVatAmount: '',
  purchasePriceIncl: '',
  salePrice: '',
  minStock: '',
  eans: '',
  posTabId: '',
  posLabel: '',
  posSort: '0',
  isFood: false,
  ingredients: '',
  allergensDecision: '',
  allergens: [],
  allergenTraces: [],
  origin: '',
  originFamily: '',
  localJustification: '',
};

const dec = (v: string | null) =>
  v === null ? '' : v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/** A stored 4-decimal amount, shown with at least 2 decimals and without trailing zeros. */
const price = (v: string | null) => {
  if (v === null) return '';
  const t = v.replace(/0+$/, '');
  const d = t.split('.')[1]?.length ?? 0;
  return Number(v).toFixed(Math.max(2, d));
};

export function productToForm(p: ProductDetail): ProductFormState {
  return {
    code: p.code,
    name: p.name,
    description: p.description ?? '',
    kind: p.kind,
    saleMode: p.saleMode,
    unitQty: dec(p.unitQty),
    unit: p.unit ?? '',
    saleCondition: p.saleCondition,
    shopVisible: p.shopVisible,
    categoryId: p.categoryId ?? '',
    supplierId: p.supplierId ?? '',
    supplierRef: p.supplierRef ?? '',
    qualities: p.qualities,
    vatRate: p.vatRate,
    status: p.status,
    purchasePriceExcl: price(p.purchasePriceExcl),
    purchaseVatAmount: price(p.purchaseVatAmount),
    purchasePriceIncl: price(p.purchasePriceIncl),
    salePrice: p.salePrice,
    minStock: dec(p.minStock),
    eans: p.eans.join(' '),
    posTabId: p.posTabId ?? '',
    posLabel: p.posLabel ?? '',
    posSort: String(p.posSort),
    isFood: p.isFood,
    ingredients: p.ingredients ?? '',
    allergensDecision: p.allergensDecision ?? '',
    allergens: p.allergens,
    allergenTraces: p.allergenTraces,
    origin: p.origin ?? '',
    originFamily: p.originFamily ?? '',
    localJustification: p.localJustification ?? '',
  };
}

export function productToPayload(f: ProductFormState): ProductCreate {
  return withServiceSale({
    name: f.name,
    description: f.description,
    kind: f.kind,
    saleMode: f.saleMode,
    unitQty: f.unitQty || null,
    unit: f.unit || null,
    saleCondition: f.saleCondition,
    shopVisible: f.shopVisible,
    categoryId: f.categoryId || null,
    supplierId: f.supplierId || null,
    supplierRef: f.supplierRef,
    qualities: f.qualities,
    vatRate: f.vatRate as ProductCreate['vatRate'],
    status: f.status,
    purchasePriceExcl: f.purchasePriceExcl || null,
    purchaseVatAmount: f.purchaseVatAmount || null,
    purchasePriceIncl: f.purchasePriceIncl || null,
    salePrice: f.salePrice,
    minStock: f.minStock || null,
    eans: f.eans.split(/[\s,;]+/).filter(Boolean),
    posTabId: f.posTabId || null,
    posLabel: f.posLabel,
    posSort: Number(f.posSort) || 0,
    // What is not food carries no allergen, ingredient or origin information.
    isFood: f.isFood && f.kind !== 'SERVICE',
    ingredients: f.isFood ? f.ingredients : '',
    allergensDecision: f.isFood && f.allergensDecision ? f.allergensDecision : null,
    allergens: f.isFood && f.allergensDecision === 'LISTED' ? f.allergens : [],
    allergenTraces: f.isFood ? f.allergenTraces : [],
    origin: f.isFood ? f.origin : '',
    originFamily: f.isFood && f.originFamily ? f.originFamily : null,
    localJustification: f.qualities.includes('LOCAL') ? f.localJustification : '',
    ...(f.code ? { code: f.code } : {}),
  });
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Nom',
  description: 'Description',
  kind: 'Type',
  saleMode: 'Vente',
  unitQty: 'Quantité unitaire',
  unit: 'Unité',
  saleCondition: 'Condition de vente',
  shopVisible: 'Visible dans la boutique',
  categoryId: 'Rayon',
  supplierId: 'Fournisseur',
  supplierRef: 'Réf. fournisseur',
  qualities: 'Qualités',
  vatRate: 'TVA',
  status: 'Statut',
  purchasePriceExcl: 'PA HT',
  purchaseVatAmount: 'Montant de TVA',
  purchasePriceIncl: 'PA TTC',
  salePrice: 'Prix de vente TTC',
  minStock: 'Stock minimum',
  eans: 'Codes-barres',
  code: 'Code',
  posTabId: 'Onglet',
  posLabel: 'Libellé du bouton',
  posSort: 'Ordre',
  isFood: 'Produit alimentaire',
  ingredients: 'Ingrédients',
  allergensDecision: 'Allergènes',
  allergens: 'Allergènes',
  allergenTraces: 'Traces',
  origin: 'Origine',
  originFamily: 'Famille d’origine obligatoire',
  localJustification: 'Justification « local »',
};

/** « Prix de vente TTC : Montant invalide. » for each refused field, so the user knows where to look. */
export function describeFieldErrors(errors: Record<string, string>): string[] {
  return Object.entries(errors).map(([path, message]) => {
    const key = path.split('.')[0] ?? path;
    const label = FIELD_LABELS[key];
    return label ? `${label} : ${message}` : message;
  });
}
