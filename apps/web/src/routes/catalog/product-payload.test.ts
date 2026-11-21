import { describe, expect, it } from 'vitest';
import { productCreateSchema } from '@episoft/shared';
import {
  describeFieldErrors,
  EMPTY_PRODUCT_FORM,
  productToPayload,
  type ProductFormState,
} from './product-payload';

const CATEGORY = '0190a0a0-0000-7000-8000-000000000001';
const form = (over: Partial<ProductFormState> = {}): ProductFormState => ({
  ...EMPTY_PRODUCT_FORM,
  ...over,
});
const issues = (f: ProductFormState) => {
  const r = productCreateSchema.safeParse(productToPayload(f));
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('the new-product form produces a payload the schema accepts', () => {
  it('minimal: a name, a shelf and a selling price', () => {
    expect(issues(form({ name: 'Chips', categoryId: CATEGORY, salePrice: '2,50' }))).toEqual([]);
  });

  it('complete: every field filled the way people type them', () => {
    expect(
      issues(
        form({
          name: 'Miel de fleurs',
          description: 'Pot de 500 g',
          categoryId: CATEGORY,
          code: '104001',
          unitQty: '0,5',
          unit: 'KG',
          purchasePriceExcl: '4,10',
          vatRate: '5.50',
          salePrice: '6,90 €',
          minStock: '2',
          eans: '3168930167983, 4006381333931',
          qualities: ['LOCAL', 'ORGANIC'],
          localJustification: 'Ferme Durand, Montjavoult, 5 km',
          supplierRef: 'REF-7',
          posLabel: 'Miel',
          posSort: '3',
        }),
      ),
    ).toEqual([]);
  });

  it('R-PRD-04: HT, VAT amount and TTC go through as typed, with no calculation', () => {
    const f = form({
      name: 'Miel',
      salePrice: '6',
      purchasePriceExcl: '4,10',
      purchaseVatAmount: '0,2255',
      purchasePriceIncl: '4,3255',
    });
    expect(issues(f)).toEqual([]);
    expect(
      issues(
        form({
          name: 'Miel',
          salePrice: '6',
          purchasePriceExcl: '4,10',
          purchaseVatAmount: '7',
          purchasePriceIncl: '1,5',
        }),
      ),
    ).not.toEqual([]);
    expect(productToPayload(f)).toMatchObject({
      purchasePriceExcl: '4,10',
      purchaseVatAmount: '0,2255',
      purchasePriceIncl: '4,3255',
    });
    expect(productToPayload(form({ name: 'Don', salePrice: '5' }))).toMatchObject({
      purchasePriceExcl: null,
      purchaseVatAmount: null,
      purchasePriceIncl: null,
    });
  });

  it('a missing selling price is the only thing refused on an otherwise empty form', () => {
    expect(issues(form({ name: 'Chips' }))).toEqual(['salePrice: Montant invalide.']);
  });

  it('names the wrong field: bad EAN, bad code, negative price', () => {
    expect(issues(form({ name: 'x', salePrice: '1', eans: '3168930167984' }))).toEqual([
      'eans: Code-barres invalide (clé de contrôle EAN-13 ou EAN-8).',
    ]);
    expect(issues(form({ name: 'x', salePrice: '1', code: '12' }))).toEqual([
      'code: Code à 5 ou 6 chiffres.',
    ]);
    expect(issues(form({ name: 'x', salePrice: '-1' }))).toEqual(['salePrice: Prix négatif.']);
  });
});

describe('a service form', () => {
  const service = (over: Partial<ProductFormState> = {}) =>
    form({ name: 'Adhésion', kind: 'SERVICE', salePrice: '10', ...over });

  it('is sent one at a time, with a quantity of 1 and no unit', () => {
    const payload = productToPayload(service());
    expect(payload).toMatchObject({ kind: 'SERVICE', saleMode: 'UNIT', unitQty: '1', unit: null });
    expect(issues(service())).toEqual([]);
  });

  it('forgets a weight or a volume left from when it was a goods product', () => {
    const payload = productToPayload(service({ saleMode: 'WEIGHT', unitQty: '0,5', unit: 'KG' }));
    expect(payload).toMatchObject({ saleMode: 'UNIT', unitQty: '1', unit: null });
  });

  it('keeps the choices of a goods product, which come back if the type is changed back', () => {
    const goods = form({
      name: 'Miel',
      salePrice: '6',
      saleMode: 'WEIGHT',
      unitQty: '0,5',
      unit: 'KG',
    });
    expect(productToPayload(goods)).toMatchObject({
      saleMode: 'WEIGHT',
      unitQty: '0,5',
      unit: 'KG',
    });
  });
});

describe('describeFieldErrors', () => {
  it('names the field of each refusal', () => {
    expect(
      describeFieldErrors({ salePrice: 'Montant invalide.', 'eans.0': 'Code-barres invalide.' }),
    ).toEqual(['Prix de vente TTC : Montant invalide.', 'Codes-barres : Code-barres invalide.']);
    expect(describeFieldErrors({ '': 'Valeur invalide.' })).toEqual(['Valeur invalide.']);
  });
});
