import { describe, expect, it } from 'vitest';
import {
  amountInput,
  householdPatchSchema,
  memberCreateSchema,
  membershipCreateSchema,
  membershipTypePatchSchema,
  positiveAmountInput,
  walletTopupSchema,
  walletCorrectionSchema,
  salePriceProblem,
  purchasePricesProblem,
} from './forms';
import {
  inventoryCreateSchema,
  inventoryValidateSchema,
  invoicePaySchema,
  invoiceTotalsProblem,
  orderCreateSchema,
  orderSchema,
  receiptCorrectionSchema,
  supplierSchema,
} from './supplies-forms';

const id = () => crypto.randomUUID();

describe('amounts as people type them', () => {
  it('amountInput: comma or dot, spaces, euro sign, rounding to the cent', () => {
    const cases = [
      ['12,5', '12.50'],
      ['1 234,567', '1234.57'],
      ['6,90 €', '6.90'],
      ['0', '0.00'],
      ['-3', '-3.00'],
    ] as const;
    for (const [typed, out] of cases) expect(amountInput.parse(typed), typed).toBe(out);
    for (const bad of ['', 'abc', '1,2,3', '12x'])
      expect(amountInput.safeParse(bad).success, bad).toBe(false);
  });
  it('positiveAmountInput refuses zero and negatives', () => {
    expect(positiveAmountInput.safeParse('0').success).toBe(false);
    expect(positiveAmountInput.safeParse('-1').success).toBe(false);
    expect(positiveAmountInput.parse('1,5')).toBe('1.50');
  });
});

const member = {
  lastName: 'Dupont',
  firstName: 'Marie',
  street: '',
  postcode: '',
  communeId: null,
  phone: '',
  email: '',
  status: 'ACTIVE',
  publicVisible: true,
  newsletter: false,
  username: '',
  householdId: null,
};

describe('member, household, cagnotte and membership forms', () => {
  it('a user name takes letters, digits and _ . - only', () => {
    const ok = (username: string) => memberCreateSchema.safeParse({ ...member, username }).success;
    expect(ok('marie.d-2')).toBe(true);
    expect(ok('marie d')).toBe(false);
    expect(ok('a@b.fr')).toBe(false);
  });
  it('a top-up is a positive amount, never paid with the cagnotte itself', () => {
    expect(walletTopupSchema.safeParse({ amount: '20', method: 'CASH' }).success).toBe(true);
    expect(walletTopupSchema.safeParse({ amount: '0', method: 'CASH' }).success).toBe(false);
    expect(walletTopupSchema.safeParse({ amount: '20', method: 'WALLET' }).success).toBe(false);
  });
  it('a membership needs a type; a type duration is bounded', () => {
    expect(membershipCreateSchema.safeParse({ typeId: id(), method: 'CASH' }).success).toBe(true);
    expect(membershipCreateSchema.safeParse({ method: 'CASH' }).success).toBe(false);
    const type = { label: 'Plein', price: '10', durationMonths: 12, active: true };
    expect(membershipTypePatchSchema.safeParse(type).success).toBe(true);
    expect(membershipTypePatchSchema.safeParse({ ...type, durationMonths: 61 }).success).toBe(
      false,
    );
  });
  it('a household patch changes only what it names', () => {
    const at = { updatedAt: '2026-11-08T10:00:00.000Z' };
    expect(Object.keys(householdPatchSchema.parse(at))).toEqual(['updatedAt']);
  });
});

describe('supplierSchema: the limits behind the form', () => {
  const base = {
    name: 'Ferme',
    communeId: null,
    active: true,
    referentMemberId: null,
    sendsPo: true,
    minOrderAmount: null,
    paymentTermsDays: 30,
    contact: '',
    street: '',
    postcode: '',
    phone: '',
    email: '',
    website: '',
    priceListUrl: '',
    publicNotes: '',
    privateNotes: '',
    accountNumber: '',
    deliveryDay: '',
  };
  const ok = (over: object) => supplierSchema.safeParse({ ...base, ...over }).success;
  it('the postcode is 5 digits or empty', () => {
    expect(ok({ postcode: '60240' })).toBe(true);
    expect(ok({ postcode: '' })).toBe(true);
    for (const bad of ['6024', '602400', '6024O', '60 240'])
      expect(ok({ postcode: bad }), bad).toBe(false);
  });
  it('the region has 1 or 2 digits, the payment terms 0 to 180 days', () => {
    expect(ok({ region: '60' })).toBe(true);
    expect(ok({ region: '600' })).toBe(false);
    expect(ok({ region: 'ab' })).toBe(false);
    expect(ok({ paymentTermsDays: 0 })).toBe(true);
    expect(ok({ paymentTermsDays: 180 })).toBe(true);
    expect(ok({ paymentTermsDays: -1 })).toBe(false);
    expect(ok({ paymentTermsDays: 1.5 })).toBe(false);
  });
  it('the minimum order is an amount, normalised', () => {
    expect(supplierSchema.parse({ ...base, minOrderAmount: '50,5' }).minOrderAmount).toBe('50.50');
    expect(ok({ minOrderAmount: 'abc' })).toBe(false);
  });
  it('the length limits', () => {
    expect(ok({ name: 'x'.repeat(200) })).toBe(true);
    expect(ok({ name: 'x'.repeat(201) })).toBe(false);
    expect(ok({ publicNotes: 'x'.repeat(2001) })).toBe(false);
  });
});

describe('other supplies forms', () => {
  it('an order may be empty; a line quantity must be a quantity', () => {
    expect(orderSchema.safeParse({ lines: [] }).success).toBe(true);
    const bad = { lines: [{ productId: id(), qty: 'x', unitPriceExcl: '1' }] };
    expect(orderSchema.safeParse(bad).success).toBe(false);
    expect(orderCreateSchema.safeParse({ supplierId: id() }).success).toBe(true);
    expect(orderCreateSchema.safeParse({ supplierId: 'x' }).success).toBe(false);
  });
  it('a receipt correction needs a line, and never a negative quantity', () => {
    const line = (qty: string) => ({ lineId: id(), qty, unitPriceExcl: '1' });
    expect(receiptCorrectionSchema.safeParse({ lines: [line('0')] }).success).toBe(true);
    expect(receiptCorrectionSchema.safeParse({ lines: [line('-1')] }).success).toBe(false);
    expect(receiptCorrectionSchema.safeParse({ lines: [] }).success).toBe(false);
  });
  it('an inventory has a label; its defaults keep sales open and uncounted products', () => {
    expect(inventoryCreateSchema.parse({ label: 'Nov', scope: {} }).freezeSales).toBe(false);
    expect(inventoryCreateSchema.safeParse({ label: '', scope: {} }).success).toBe(false);
    expect(inventoryValidateSchema.parse({}).zeroUncounted).toBe(false);
  });
  it('paying an invoice needs a date and a known method', () => {
    const pay = (date: string, method: string) =>
      invoicePaySchema.safeParse({ date, method }).success;
    expect(pay('2026-11-08', 'TRANSFER')).toBe(true);
    expect(pay('8/11', 'TRANSFER')).toBe(false);
    expect(pay('2026-11-08', 'BITCOIN')).toBe(false);
  });
});

describe('lot A: integrity of entries', () => {
  const base = {
    kind: 'GOODS',
    salePrice: '1.00',
    purchasePriceExcl: '2.0000',
    vatRate: '5.50',
  };
  it('refuses a sale price of 0 for goods but not for a service', () => {
    expect(salePriceProblem({ ...base, salePrice: '0.00' })?.path).toBe('salePrice');
    expect(salePriceProblem({ ...base, kind: 'SERVICE', salePrice: '0.00' })).toBeNull();
  });
  it('refuses a resale at a loss unless a reason is given (L442-5)', () => {
    expect(salePriceProblem(base)?.message).toMatch(/revente à perte/);
    expect(salePriceProblem({ ...base, belowCostReason: 'Date courte' })).toBeNull();
    // 2.00 HT at 5.5 % = 2.11 TTC: 2.11 is at cost, 2.10 is below.
    expect(salePriceProblem({ ...base, salePrice: '2.11' })).toBeNull();
    expect(salePriceProblem({ ...base, salePrice: '2.10' })).not.toBeNull();
  });
  it('checks the VAT amount against the rate, one cent apart', () => {
    const p = { purchasePriceExcl: '10.0000', vatRate: '5.50' };
    expect(purchasePricesProblem({ ...p, purchaseVatAmount: '0.5500' })).toBeNull();
    expect(purchasePricesProblem({ ...p, purchaseVatAmount: '0.5600' })).toBeNull();
    expect(purchasePricesProblem({ ...p, purchaseVatAmount: '0.7000' })).toMatch(/taux du produit/);
    expect(
      purchasePricesProblem({ purchasePriceExcl: '10.0000', purchaseVatAmount: '0.7000' }),
    ).toBeNull();
  });
  it('caps top-ups, corrections and invoices', () => {
    expect(walletTopupSchema.safeParse({ amount: '1000.01', method: 'CASH' }).success).toBe(false);
    expect(walletTopupSchema.safeParse({ amount: '1000', method: 'CASH' }).success).toBe(true);
    expect(
      walletCorrectionSchema.safeParse({ amount: '-500.01', comment: 'erreur de saisie' }).success,
    ).toBe(false);
    expect(
      walletCorrectionSchema.safeParse({ amount: '-500', comment: 'erreur de saisie' }).success,
    ).toBe(true);
    expect(invoiceTotalsProblem('100000.01', '0.00', '100000.01')).toMatch(/trop élevé/);
    expect(invoiceTotalsProblem('100.00', '20.00', '120.00')).toBeNull();
  });
});
