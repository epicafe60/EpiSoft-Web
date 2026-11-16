import { describe, expect, it } from 'vitest';
import {
  allergenSentence,
  ALLERGENS,
  foodInfoProblems,
  organicCertProblem,
  organicClaimProblem,
  organicState,
  parseAllergenList,
  publicClaims,
} from './compliance';
import { productCreateSchema } from './forms';

// Règlement UE 1169/2011 (allergens, ingredients, origin), 2018/848 (bio), DGCCRF (local).

const base = {
  kind: 'GOODS',
  isFood: true,
  saleMode: 'UNIT',
  unitQty: '500',
  unit: 'G',
  ingredients: 'Farine de blé',
  allergensDecision: 'LISTED',
  allergens: ['GLUTEN'],
  qualities: [] as string[],
};

describe('the 14 allergens', () => {
  it('are the 14 of the regulation', () => expect(ALLERGENS).toHaveLength(14));
});

describe('foodInfoProblems', () => {
  it('accepts a complete food product', () => expect(foodInfoProblems(base)).toEqual([]));

  it('refuses a food product whose allergen decision was not taken', () => {
    const p = foodInfoProblems({ ...base, allergensDecision: null, allergens: [] });
    expect(p[0]).toMatchObject({ path: 'allergensDecision' });
    expect(p[0]!.message).toMatch(/Aucun allergène déclaré/);
  });

  it('takes « aucun allergène » as an explicit choice, and refuses contradictions', () => {
    expect(foodInfoProblems({ ...base, allergensDecision: 'NONE', allergens: [] })).toEqual([]);
    expect(
      foodInfoProblems({ ...base, allergensDecision: 'NONE', allergens: ['MILK'] }),
    ).toHaveLength(1);
    expect(
      foodInfoProblems({ ...base, allergensDecision: 'LISTED', allergens: [] }),
    ).toHaveLength(1);
  });

  it('asks the ingredients and, for a piece, the net quantity', () => {
    expect(foodInfoProblems({ ...base, ingredients: null }).map((x) => x.path)).toEqual([
      'ingredients',
    ]);
    expect(foodInfoProblems({ ...base, unitQty: null }).map((x) => x.path)).toEqual(['unitQty']);
    expect(foodInfoProblems({ ...base, saleMode: 'WEIGHT', unitQty: null, unit: 'KG' })).toEqual(
      [],
    );
  });

  it('asks the origin where the law makes it compulsory', () => {
    const honey = { ...base, originFamily: 'HONEY' };
    expect(foodInfoProblems(honey).map((x) => x.path)).toEqual(['origin']);
    expect(foodInfoProblems({ ...honey, origin: 'France, Oise' })).toEqual([]);
  });

  it('does not ask a non-food product anything, and refuses a food service', () => {
    expect(foodInfoProblems({ kind: 'GOODS', isFood: false })).toEqual([]);
    expect(foodInfoProblems({ kind: 'SERVICE', isFood: true })).toHaveLength(1);
  });

  it('asks a justification for « local »', () => {
    const local = { ...base, qualities: ['LOCAL'] };
    expect(foodInfoProblems(local).map((x) => x.path)).toEqual(['localJustification']);
    expect(foodInfoProblems({ ...local, localJustification: 'Ferme Durand, 5 km' })).toEqual([]);
  });
});

describe('the product form schema', () => {
  const form = {
    name: 'Farine T65',
    description: null,
    supplierRef: null,
    kind: 'GOODS',
    saleMode: 'UNIT',
    unitQty: '1',
    unit: 'KG',
    saleCondition: 'ON_SITE',
    categoryId: null,
    supplierId: null,
    qualities: [],
    vatRate: '5.50',
    status: 'ACTIVE',
    purchasePriceExcl: null,
    salePrice: '2.50',
    minStock: null,
    eans: [],
    posTabId: null,
    posLabel: null,
    posSort: 0,
  };
  it('still accepts a non-food product with nothing about food', () => {
    expect(productCreateSchema.safeParse(form).success).toBe(true);
  });
  it('refuses a food product without allergen decision, in French', () => {
    const r = productCreateSchema.safeParse({ ...form, isFood: true, ingredients: 'Blé' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toMatch(/Allergènes/);
  });
  it('accepts a complete food product', () => {
    expect(
      productCreateSchema.safeParse({
        ...form,
        isFood: true,
        ingredients: 'Farine de blé',
        allergensDecision: 'LISTED',
        allergens: ['GLUTEN'],
      }).success,
    ).toBe(true);
  });
});

describe('organic claim', () => {
  const ok = { name: 'Ferme', number: 'FR-BIO-01-123', body: 'Ecocert', expiry: '2027-03-01' };
  it('is allowed with a valid certificate', () => {
    expect(organicClaimProblem(ok, '2026-11-15')).toBeNull();
    expect(organicState(ok, '2027-03-01')).toBe('VALID');
  });
  it('is refused without supplier, without certificate, or with an expired one', () => {
    expect(organicClaimProblem(null, '2026-11-15')).toMatch(/fournisseur/);
    expect(organicClaimProblem({ ...ok, number: null }, '2026-11-15')).toMatch(
      /pas de certificat/,
    );
    expect(organicClaimProblem({ ...ok, expiry: '2026-11-14' }, '2026-11-15')).toMatch(
      /a expiré le 14\/11\/2026/,
    );
  });
  it('wants the three parts of the certificate together', () => {
    expect(organicCertProblem({})).toBeNull();
    expect(
      organicCertProblem({
        organicCertNumber: 'x',
        organicCertBody: 'y',
        organicCertExpiry: '2027-01-01',
      }),
    ).toBeNull();
    expect(organicCertProblem({ organicCertNumber: 'x' })).toMatch(/incomplet/);
  });
  it('is shown to the public only while valid', () => {
    expect(publicClaims({ qualities: ['ORGANIC'], organic: 'EXPIRED' }).organic).toBe(false);
    expect(publicClaims({ qualities: ['ORGANIC'], organic: 'VALID' }).organic).toBe(true);
  });
});

describe('allergen text', () => {
  it('writes the sentence of the label', () => {
    expect(
      allergenSentence({
        allergensDecision: 'LISTED',
        allergens: ['MILK', 'EGGS'],
        allergenTraces: ['NUTS'],
      }),
    ).toBe('Contient : lait, œufs. Peut contenir des traces de : fruits à coque.');
    expect(
      allergenSentence({ allergensDecision: 'NONE', allergens: [], allergenTraces: [] }),
    ).toBe('Aucun allergène déclaré.');
    expect(allergenSentence({ allergensDecision: null })).toBeNull();
  });
  it('reads a typed list', () => {
    expect(parseAllergenList('Lait, oeufs ; sésame').allergens).toEqual([
      'EGGS',
      'MILK',
      'SESAME',
    ]);
    expect(parseAllergenList('aucun').decision).toBe('NONE');
    expect(parseAllergenList('lait, truc').unknown).toEqual(['truc']);
    expect(parseAllergenList('').decision).toBeNull();
  });
});
