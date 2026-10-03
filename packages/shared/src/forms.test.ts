import { describe, expect, it } from 'vitest';
import {
  memberCreateSchema,
  memberPatchSchema,
  productCreateSchema,
  purchasePriceIncl,
  walletCorrectionSchema,
} from './forms';

const member = {
  lastName: ' Dupont ',
  firstName: 'Marie',
  street: '',
  postcode: '60240',
  communeId: null,
  phone: '',
  email: 'marie@example.org',
  status: 'ACTIVE',
  publicVisible: false,
  newsletter: true,
  username: 'Marie_DUPONT',
  householdId: null,
};

describe('member forms (R-MBR-01, R-MBR-09)', () => {
  it('normalises empty strings to null and trims', () => {
    const m = memberCreateSchema.parse(member);
    expect(m).toMatchObject({ lastName: 'Dupont', street: null, phone: null });
  });

  it('validates e-mail and postcode', () => {
    expect(memberCreateSchema.safeParse({ ...member, email: 'x' }).success).toBe(false);
    expect(memberCreateSchema.safeParse({ ...member, postcode: '602240' }).success).toBe(false);
  });

  it('a patch only carries the fields present', () => {
    const p = memberPatchSchema.parse({
      phone: '06 00 00 00 00',
      updatedAt: '2026-10-03T10:00:00Z',
    });
    expect(Object.keys(p).sort()).toEqual(['phone', 'updatedAt']);
  });
});

describe('product form (R-PRD-01, R-PRD-04)', () => {
  const p = {
    name: 'Chips',
    description: '',
    kind: 'GOODS',
    saleMode: 'UNIT',
    unitQty: '0,155',
    unit: 'KG',
    saleCondition: 'ON_SITE',
    categoryId: null,
    supplierId: null,
    supplierRef: '',
    qualities: ['LOCAL'],
    vatRate: '5.50',
    status: 'ACTIVE',
    purchasePriceExcl: '1,2',
    salePrice: '2,5',
    minStock: null,
    eans: ['3168930167983'],
    posTabId: null,
    posLabel: '',
    posSort: 0,
  };

  it('normalises amounts and quantities', () => {
    expect(productCreateSchema.parse(p)).toMatchObject({
      unitQty: '0.155',
      purchasePriceExcl: '1.20',
      salePrice: '2.50',
    });
  });

  it('refuses an EAN with a wrong check digit', () => {
    expect(productCreateSchema.safeParse({ ...p, eans: ['3168930167984'] }).success).toBe(false);
  });

  it('computes PA TTC from PA HT and VAT', () => {
    expect(purchasePriceIncl('1.20', '5.50')).toBe('1.2660');
    expect(purchasePriceIncl('10', '20.00')).toBe('12.0000');
  });
});

describe('cagnotte correction (R-CAG-08)', () => {
  it('needs a reason and a non-zero amount', () => {
    expect(
      walletCorrectionSchema.safeParse({ amount: '-5', comment: 'erreur de saisie' }).success,
    ).toBe(true);
    expect(walletCorrectionSchema.safeParse({ amount: '0', comment: 'erreur' }).success).toBe(
      false,
    );
    expect(walletCorrectionSchema.safeParse({ amount: '5', comment: '' }).success).toBe(false);
  });
});
