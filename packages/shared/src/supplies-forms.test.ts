import { describe, expect, it } from 'vitest';
import {
  bulkPricesSchema,
  categorySchema,
  correctionSchema,
  inventoryCountSchema,
  invoiceSchema,
  resolveInvoiceAmounts,
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

describe('invoices (R-FAC-01, R-TVA-03)', () => {
  const base = {
    supplierId: id(),
    pieceRef: 'F-1',
    date: '2026-10-01',
    vatLines: [{ rate: '0', excl: '100', vat: '0' }],
    paymentMethod: null,
    comment: '',
  };
  it('accepts a zero VAT line and normalises amounts and rates', () => {
    const r = invoiceSchema.parse(base);
    expect(r).toMatchObject({
      vatLines: [{ rate: '0.00', excl: '100.00', vat: '0.00' }],
      receiptIds: [],
      comment: null,
    });
  });
  it('accepts several rates and refuses a VAT that does not match its rate', () => {
    const ok = invoiceSchema.parse({
      ...base,
      vatLines: [
        { rate: '5,5', excl: '100', vat: '5,50' },
        { rate: '20', excl: '50', vat: '10' },
      ],
    });
    expect(ok.vatLines.map((l) => l.rate)).toEqual(['5.50', '20.00']);
    const bad = (vatLines: object[]) => invoiceSchema.safeParse({ ...base, vatLines }).success;
    expect(bad([{ rate: '5.5', excl: '100', vat: '5,53' }])).toBe(false);
    expect(bad([{ rate: '5.5', excl: '100', vat: '5,52' }])).toBe(true);
    expect(bad([{ rate: '7', excl: '100', vat: '7' }])).toBe(false);
    expect(bad([{ rate: '20', excl: '-100', vat: '-20' }])).toBe(false);
    expect(bad([{ rate: '20', excl: '100', vat: '25' }])).toBe(false);
    expect(
      bad([
        { rate: '20', excl: '100', vat: '20' },
        { rate: '20.00', excl: '10', vat: '2' },
      ]),
    ).toBe(false);
    expect(bad([])).toBe(false); // neither a breakdown nor a total
  });
  it('amounts by regime (R-TVA-03)', () => {
    const lines = invoiceSchema.parse({
      ...base,
      vatLines: [{ rate: '20', excl: '100', vat: '20' }],
    }).vatLines;
    expect(resolveInvoiceAmounts('LIABLE', { vatLines: lines })).toMatchObject({
      ok: true,
      totalIncl: '120.00',
      totalVat: '20.00',
    });
    expect(resolveInvoiceAmounts('LIABLE', { vatLines: [], totalIncl: '120.00' })).toMatchObject({
      ok: false,
    });
    for (const regime of ['FRANCHISE', 'EXEMPT'] as const) {
      expect(resolveInvoiceAmounts(regime, { vatLines: [], totalIncl: '120.00' })).toMatchObject({
        ok: true,
        totalExcl: '120.00',
        totalVat: '0.00',
        totalIncl: '120.00',
        lines: [],
      });
      expect(resolveInvoiceAmounts(regime, { vatLines: lines })).toMatchObject({
        ok: true,
        totalIncl: '120.00',
      });
      expect(resolveInvoiceAmounts(regime, { vatLines: lines, totalIncl: '130.00' })).toMatchObject(
        { ok: false },
      );
      expect(resolveInvoiceAmounts(regime, { vatLines: [] })).toMatchObject({ ok: false });
    }
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
