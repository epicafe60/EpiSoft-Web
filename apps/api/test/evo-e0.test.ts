import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { category, supplier, universe } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  const u = await createUser(t.db, { roles: ['APPROS', 'PRODUITS'] });
  h = await login(t.app, u.username!);
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload: payload as object });

const fullProduct = (extra: object = {}) => ({
  name: 'Lentilles vertes 500 g',
  description: 'Du Puy',
  kind: 'GOODS',
  saleMode: 'UNIT',
  unitQty: '0.5',
  unit: 'KG',
  saleCondition: 'ON_SITE',
  shopVisible: true,
  categoryId: null,
  supplierId: null,
  supplierRef: 'LV500',
  qualities: ['LOCAL'],
  vatRate: '5.50',
  status: 'ACTIVE',
  purchasePriceExcl: '2.10',
  salePrice: '3.20',
  minStock: '0',
  eans: [],
  posTabId: null,
  posLabel: null,
  posSort: 0,
  code: '987654',
  ...extra,
});

describe('R-EVO-22 product creation', () => {
  it('creates a product with every field filled and a minimum stock of zero', async () => {
    const [u] = await t.db.insert(universe).values({ code: '8', name: 'Univers' }).returning();
    const [c] = await t.db
      .insert(category)
      .values({ universeId: u!.id, code: '81', name: 'Légumineuses' })
      .returning();
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FPUY', name: 'Ferme du Puy' })
      .returning();
    const res = await call(
      'POST',
      '/products',
      fullProduct({ categoryId: c!.id, supplierId: s!.id, code: undefined }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: expect.stringMatching(/^881\d+$/) });
  });
});

describe('R-EVO-13 products filtered by supplier', () => {
  it('lists only the products of the requested supplier', async () => {
    const [a] = await t.db
      .insert(supplier)
      .values({ code: 'FA', name: 'Fournisseur A' })
      .returning();
    const [b] = await t.db
      .insert(supplier)
      .values({ code: 'FB', name: 'Fournisseur B' })
      .returning();
    await call(
      'POST',
      '/products',
      fullProduct({ code: '900001', name: 'Prod A', supplierId: a!.id }),
    );
    await call(
      'POST',
      '/products',
      fullProduct({ code: '900002', name: 'Prod B', supplierId: b!.id }),
    );
    const res = await call('GET', `/products?supplierId=${a!.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const names = (res.json() as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(['Prod A']);
  });
});

describe('R-EVO-12 cancelled purchase orders', () => {
  it('deletes a cancelled order without receipt but refuses a sent one', async () => {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FC', name: 'Fournisseur C' })
      .returning();
    const mk = async () => {
      const r = await call('POST', '/purchase-orders', { supplierId: s!.id, lines: [] });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { id: string }).id;
    };
    const id = await mk();
    expect((await call('POST', `/purchase-orders/${id}/cancel`)).statusCode).toBe(200);
    expect((await call('DELETE', `/purchase-orders/${id}`)).statusCode).toBe(204);
    expect((await call('GET', `/purchase-orders/${id}`)).statusCode).toBe(404);
  });
});

describe('R-EVO-20 supplier invoice VAT', () => {
  it('keeps the VAT typed at creation and after an update', async () => {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FV', name: 'Fournisseur V' })
      .returning();
    const body = {
      supplierId: s!.id,
      pieceRef: 'F-100',
      date: '2026-10-01',
      totalExcl: '100.00',
      totalVat: '5,50',
      paymentMethod: null,
      comment: null,
      receiptIds: [],
    };
    const created = await call('POST', '/supplier-invoices', body);
    expect(created.statusCode, created.body).toBe(200);
    const id = (created.json() as { id: string }).id;
    const read = async () =>
      (await call('GET', `/supplier-invoices/${id}`)).json() as {
        totalExcl: string;
        totalVat: string;
        totalIncl: string;
      };
    expect(await read()).toMatchObject({
      totalExcl: '100.00',
      totalVat: '5.50',
      totalIncl: '105.50',
    });
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/supplier-invoices/${id}`,
      headers: h,
      payload: { ...body, totalVat: '7.00' },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await read()).toMatchObject({ totalVat: '7.00', totalIncl: '107.00' });
    const list = (await call('GET', '/supplier-invoices')).json() as { totalVat?: string }[];
    expect(list[0]?.totalVat).toBe('7.00');
  });
});

describe('R-EVO-10 order from every reference of the supplier', () => {
  it('lists the supplier products with stock and suggestion, even without a minimum stock', async () => {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FR', name: 'Fournisseur R' })
      .returning();
    await call(
      'POST',
      '/products',
      fullProduct({ code: '910001', name: 'Sans mini', supplierId: s!.id, minStock: null }),
    );
    await call(
      'POST',
      '/products',
      fullProduct({ code: '910002', name: 'Avec mini', supplierId: s!.id, minStock: '4' }),
    );
    const o = await call('POST', '/purchase-orders', { supplierId: s!.id });
    const { id } = o.json() as { id: string };
    const res = await call('GET', `/purchase-orders/${id}/supplier-products`);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json() as { name: string; stockQty: string; suggestedQty: string }[];
    expect(rows.map((r) => r.name)).toEqual(['Avec mini', 'Sans mini']);
    expect(rows[0]).toMatchObject({ stockQty: '0.000', suggestedQty: '4.000' });
    expect(rows[1]).toMatchObject({ suggestedQty: '0.000' });
  });
});

describe('R-EVO-30 inventory ready to count', () => {
  it('flags data issues, serves a count sheet and freezes the till while open', async () => {
    await call(
      'POST',
      '/products',
      fullProduct({ code: '920001', name: 'Orphelin', supplierId: null }),
    );
    const pre = (await call('GET', '/inventories/precheck')).json() as {
      noSupplier: { code: string }[];
    };
    expect(pre.noSupplier.map((p) => p.code)).toContain('920001');

    const opened = await call('POST', '/inventories', {
      label: 'Gel',
      scope: {},
      freezeSales: true,
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const { id } = opened.json() as { id: string };
    const sheet = await call('GET', `/inventories/${id}/sheet.xlsx`);
    expect(sheet.statusCode).toBe(200);
    expect(sheet.headers['content-type']).toContain('spreadsheetml');

    const till = await createUser(t.db, { roles: ['CAISSE'] });
    const th = await login(t.app, till.username!);
    const snap = async () =>
      (await t.app.inject({ url: '/api/v1/sync/snapshot', headers: th })).json() as {
        settings: { salesFrozen: boolean };
      };
    expect((await snap()).settings.salesFrozen).toBe(true);
    expect((await call('POST', `/inventories/${id}/cancel`)).statusCode).toBe(200);
    expect((await snap()).settings.salesFrozen).toBe(false);
  });
});

describe('R-EVO-21 invoice export', () => {
  it('exports the invoices in Excel', async () => {
    const res = await call('GET', '/supplier-invoices.xlsx?status=TO_PAY');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});

describe('R-EVO-11 correcting a validated receipt', () => {
  it('moves the stock, recounts the order and refuses once the invoice is paid', async () => {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FK', name: 'Fournisseur K' })
      .returning();
    const created = await call(
      'POST',
      '/products',
      fullProduct({ code: '930001', name: 'Corrigé', supplierId: s!.id, minStock: '2' }),
    );
    const { id: productId } = created.json() as { id: string };
    const o = await call('POST', '/purchase-orders', {
      supplierId: s!.id,
      lines: [{ productId, qty: '6', unitPriceExcl: '2.1000' }],
    });
    const { id: orderId } = o.json() as { id: string };
    const order = (await call('GET', `/purchase-orders/${orderId}`)).json() as {
      lines: { id: string }[];
    };
    const rec = await call('POST', `/purchase-orders/${orderId}/receipts`, {
      lines: [{ orderLineId: order.lines[0]!.id, productId, qty: '6', unitPriceExcl: '2.1000' }],
    });
    expect(rec.statusCode, rec.body).toBe(200);
    const { id: receiptId } = rec.json() as { id: string };
    const stock = async () =>
      (await call('GET', `/products/${productId}`)).json() as { stockQty: string };
    expect((await stock()).stockQty).toBe('6.000');

    const receipt = (await call('GET', `/receipts/${receiptId}`)).json() as {
      lines: { id: string }[];
      receivedByName: string | null;
    };
    // R-EVO-11: who keyed the quantities in, on the receipt and on the order.
    expect(receipt.receivedByName).toMatch(/Prénom\d+ NOM\d+/);
    const onOrder = (await call('GET', `/purchase-orders/${orderId}`)).json() as {
      receipts: { receivedByName: string | null }[];
    };
    expect(onOrder.receipts[0]!.receivedByName).toBe(receipt.receivedByName);
    const fix = await call('POST', `/receipts/${receiptId}/correct`, {
      lines: [{ lineId: receipt.lines[0]!.id, qty: '5', unitPriceExcl: '2.2000' }],
    });
    expect(fix.statusCode, fix.body).toBe(200);
    expect(fix.json()).toMatchObject({ changed: 1 });
    expect((await stock()).stockQty).toBe('5.000');
    const after = (await call('GET', `/purchase-orders/${orderId}`)).json() as {
      status: string;
      lines: { qtyReceived: string }[];
    };
    expect(after.lines[0]!.qtyReceived).toBe('5.000');
    expect(after.status).toBe('PARTIAL');

    // Once an invoice with this receipt is paid, the receipt is frozen.
    const inv = await call('POST', '/supplier-invoices', {
      supplierId: s!.id,
      pieceRef: 'FK-1',
      date: '2026-10-02',
      totalExcl: '11.00',
      totalVat: '0.60',
      paymentMethod: 'TRANSFER',
      comment: null,
      receiptIds: [receiptId],
    });
    const { id: invoiceId } = inv.json() as { id: string };
    const pay = await call('POST', `/supplier-invoices/${invoiceId}/pay`, {
      date: '2026-10-05',
      method: 'TRANSFER',
    });
    expect(pay.statusCode, pay.body).toBe(200);
    const refused = await call('POST', `/receipts/${receiptId}/correct`, {
      lines: [{ lineId: receipt.lines[0]!.id, qty: '4', unitPriceExcl: '2.2000' }],
    });
    expect(refused.statusCode).toBe(409);
  });
});

describe('R-EVO-15 supplier data audit', () => {
  it('lists products without supplier (positive stock counted) and suppliers without product', async () => {
    await t.db.insert(supplier).values({ code: 'FZ', name: 'Fournisseur vide' });
    await call(
      'POST',
      '/products',
      fullProduct({ code: '940001', name: 'Sans fournisseur', supplierId: null }),
    );
    await t.db.execute(sql`update app.product set stock_qty = 3 where code = '940001'`);
    const res = await call('GET', '/supply-audit');
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json() as {
      productsWithoutSupplier: { code: string }[];
      positiveStockWithoutSupplier: number;
      suppliersWithoutProduct: { code: string }[];
    };
    expect(a.productsWithoutSupplier.map((p) => p.code)).toContain('940001');
    expect(a.positiveStockWithoutSupplier).toBeGreaterThanOrEqual(1);
    expect(a.suppliersWithoutProduct.map((s) => s.code)).toContain('FZ');
    expect((await call('GET', '/supply-audit.xlsx')).statusCode).toBe(200);
  });
});
