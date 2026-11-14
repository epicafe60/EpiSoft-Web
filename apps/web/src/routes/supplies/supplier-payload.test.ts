import { describe, expect, it } from 'vitest';
import { supplierSchema } from '@episoft/shared';
import { EMPTY_SUPPLIER_FORM, supplierPayload, type SupplierFormState } from './supplier-payload';

const form = (over: Partial<SupplierFormState> = {}): SupplierFormState => ({
  ...EMPTY_SUPPLIER_FORM,
  ...over,
});
const issues = (f: SupplierFormState, existing: { code: string } | null = null) => {
  const r = supplierSchema.safeParse(supplierPayload(f, existing));
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('the supplier form produces a payload the schema accepts', () => {
  it('only a name is needed (R-FNR-02); the region defaults to 99', () => {
    expect(issues(form({ name: 'Ferme du Coin' }))).toEqual([]);
    expect(supplierPayload(form({ name: 'x' }), null)).toMatchObject({ region: '99' });
  });
  it('a complete sheet with a postcode and a town', () => {
    expect(
      issues(
        form({
          name: 'Ferme du Coin',
          region: '60',
          street: '1 rue du Marais',
          postcode: '60240',
          communeId: '0190a0a0-0000-7000-8000-000000000001',
          email: 'ferme@exemple.fr',
          phone: '03 44 00 00 00',
          minOrderAmount: '50,00',
          paymentTermsDays: 45,
        }),
      ),
    ).toEqual([]);
  });
  it('refuses a postcode that is not 5 digits', () => {
    expect(issues(form({ name: 'x', postcode: '6024' }))).toEqual([
      'postcode: Code postal à 5 chiffres.',
    ]);
    expect(issues(form({ name: 'x', postcode: '6024O' }))).toEqual([
      'postcode: Code postal à 5 chiffres.',
    ]);
  });
  it('an existing supplier sends its code only when it changed', () => {
    const p = supplierPayload(form({ name: 'x', code: '601001' }), { code: '601001' });
    expect(p).not.toHaveProperty('code');
    expect(p).not.toHaveProperty('region');
    expect(supplierPayload(form({ name: 'x', code: '601002' }), { code: '601001' })).toMatchObject({
      code: '601002',
    });
  });
});
