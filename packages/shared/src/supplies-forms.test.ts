import { describe, expect, it } from 'vitest';
import {
  bulkPricesSchema,
  categorySchema,
  correctionSchema,
  inventoryCountSchema,
  invoiceSchema,
  labelsSchema,
  lossSchema,
  orderLineSchema,
  orderSendSchema,
  price4Input,
  qtyInput,
  receiptSchema,
  supplierSchema,
  universeSchema,
} from './supplies-forms';

const id = () => crypto.randomUUID();

describe('qtyInput / price4Input', () => {
  it('normalises quantities to 3 decimals', () => {
    expect(qtyInput.parse('1,5')).toBe('1.500');
    expect(qtyInput.parse(' 2 ')).toBe('2.000');
    expect(qtyInput.safeParse('1.2345').success).toBe(false);
    expect(qtyInput.safeParse('abc').success).toBe(false);
  });
  it('normalises prices to 4 decimals and refuses negatives', () => {
    expect(price4Input.parse('1,2')).toBe('1.2000');
    expect(price4Input.parse('0')).toBe('0.0000');
    expect(price4Input.safeParse('-1').success).toBe(false);
    expect(price4Input.safeParse('1.23456').success).toBe(false);
  });
});

describe('supplierSchema (R-FNR-02)', () => {
  const full = {
    name: 'Ferme du Coin',
    communeId: null,
    active: true,
    referentMemberId: null,
    sendsPo: false,
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
  it('only the name is required; blanks become null', () => {
    const r = supplierSchema.parse(full);
    expect(r.contact).toBeNull();
    expect(r.email).toBeNull();
  });
  it('validates the e-mail, code and payment terms', () => {
    expect(supplierSchema.safeParse({ ...full, email: 'x' }).success).toBe(false);
    expect(supplierSchema.safeParse({ ...full, code: '12' }).success).toBe(false);
    expect(supplierSchema.safeParse({ ...full, code: '1234' }).success).toBe(true);
    expect(supplierSchema.safeParse({ ...full, paymentTermsDays: 181 }).success).toBe(false);
    expect(supplierSchema.safeParse({ ...full, name: ' ' }).success).toBe(false);
  });
});

describe('orders and receipts', () => {
  it('normalises order lines', () => {
    const r = orderLineSchema.parse({ productId: id(), qty: '2', unitPriceExcl: '1,5' });
    expect(r).toMatchObject({ qty: '2.000', unitPriceExcl: '1.5000' });
  });
  it('validates the e-mail sending', () => {
    expect(orderSendSchema.safeParse({ to: 'a@b.fr', subject: 's', message: '' }).success).toBe(
      true,
    );
    expect(orderSendSchema.safeParse({ to: 'a', subject: 's', message: '' }).success).toBe(false);
    expect(orderSendSchema.safeParse({ to: 'a@b.fr', subject: '', message: '' }).success).toBe(
      false,
    );
  });
  it('a receipt needs a positive quantity on at least one line (R-CMD-05)', () => {
    const line = (qty: string) => ({
      orderLineId: null,
      productId: id(),
      qty,
      unitPriceExcl: '1',
    });
    expect(receiptSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(receiptSchema.safeParse({ lines: [line('0')] }).success).toBe(false);
    expect(receiptSchema.safeParse({ lines: [line('-1')] }).success).toBe(false);
    const ok = receiptSchema.parse({ lines: [line('3')] });
    expect(ok.closeOrder).toBe(false);
    expect(ok.newSalePrices).toEqual({});
  });
  it('normalises accepted selling prices', () => {
    const pid = id();
    const r = receiptSchema.parse({
      lines: [{ orderLineId: null, productId: pid, qty: '1', unitPriceExcl: '1' }],
      newSalePrices: { [pid]: '2,5' },
    });
    expect(r.newSalePrices[pid]).toBe('2.50');
  });
});

describe('stock forms (R-STK-03/04)', () => {
  it('a loss is positive and needs a reason', () => {
    expect(lossSchema.safeParse({ productId: id(), qty: '1', reason: 'cassé' }).success).toBe(true);
    expect(lossSchema.safeParse({ productId: id(), qty: '-1', reason: 'cassé' }).success).toBe(
      false,
    );
    expect(lossSchema.safeParse({ productId: id(), qty: '1', reason: 'x' }).success).toBe(false);
  });
  it('a correction may be negative but not zero', () => {
    const c = (qty: string) =>
      correctionSchema.safeParse({ productId: id(), qty, comment: 'vol' }).success;
    expect(c('-2')).toBe(true);
    expect(c('0')).toBe(false);
    expect(c('-0.000')).toBe(false);
  });
  it('an inventory count is never negative', () => {
    expect(inventoryCountSchema.safeParse({ mode: 'add', qty: '3' }).success).toBe(true);
    expect(inventoryCountSchema.safeParse({ mode: 'set', qty: '-1' }).success).toBe(false);
    expect(inventoryCountSchema.safeParse({ mode: 'sum', qty: '1' }).success).toBe(false);
  });
});

describe('invoices (R-FAC-01)', () => {
  const base = {
    supplierId: id(),
    pieceRef: 'F-1',
    date: '2026-10-01',
    totalExcl: '100',
    totalVat: '0',
    paymentMethod: null,
    comment: '',
  };
  it('accepts a zero VAT and normalises amounts', () => {
    const r = invoiceSchema.parse(base);
    expect(r).toMatchObject({
      totalExcl: '100.00',
      totalVat: '0.00',
      receiptIds: [],
      comment: null,
    });
  });
  it('requires a piece number', () => {
    expect(invoiceSchema.safeParse({ ...base, pieceRef: ' ' }).success).toBe(false);
  });
});

describe('catalogue administration', () => {
  it('universe code is one digit, category code two', () => {
    expect(universeSchema.safeParse({ code: '1', name: 'Épicerie', sort: 0 }).success).toBe(true);
    expect(universeSchema.safeParse({ code: '12', name: 'x', sort: 0 }).success).toBe(false);
    expect(
      categorySchema.safeParse({ universeId: id(), code: '12', name: 'x', sort: 0 }).success,
    ).toBe(true);
    expect(
      categorySchema.safeParse({ universeId: id(), code: '1', name: 'x', sort: 0 }).success,
    ).toBe(false);
  });
  it('bulk prices accept only the legal VAT rates', () => {
    const row = (vatRate: string) => ({
      productId: id(),
      purchasePriceExcl: '1',
      vatRate,
      salePrice: '2',
      active: true,
    });
    expect(bulkPricesSchema.safeParse({ rows: [row('5.50')] }).success).toBe(true);
    expect(bulkPricesSchema.safeParse({ rows: [row('7.00')] }).success).toBe(false);
    expect(bulkPricesSchema.safeParse({ rows: [] }).success).toBe(false);
  });
  it('labels are 24 or 40 per page', () => {
    expect(labelsSchema.parse({ productIds: [id()] }).markDone).toBe(false);
    expect(labelsSchema.safeParse({ productIds: [id()], perPage: 30 }).success).toBe(false);
    expect(labelsSchema.safeParse({ productIds: [] }).success).toBe(false);
  });
});
