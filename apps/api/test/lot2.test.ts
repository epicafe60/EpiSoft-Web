import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  emailOutbox,
  priceHistory,
  product,
  purchaseOrder,
  setting,
  stockMovement,
  supplier,
  type Db,
} from '@episoft/db';
import { addDays } from '@episoft/shared';
import { toParisDate } from '../src/lib/dates';
import { recordMovement } from '../src/modules/stock/ledger';
import { sendDueInvoiceAlerts } from '../src/modules/supplies/invoices';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

async function resetLot2(db: Db) {
  await db.execute(sql`truncate app.invoice_receipt, app.supplier_invoice, app.goods_receipt_line, app.goods_receipt,
    app.purchase_order_line, app.purchase_order, app.inventory_line, app.inventory_session, app.stock_movement,
    app.price_history, app.number_counter, app.product_barcode cascade`);
  await db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
  await db.execute(sql`delete from app.supplier`);
}

beforeEach(async () => {
  await t.reset();
  await resetLot2(t.db);
  const u = await createUser(t.db, { roles: ['APPROS', 'PRODUITS', 'COMPTA'] });
  h = await login(t.app, u.username!);
});

const post = (url: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers: h, payload: payload as object });
const put = (url: string, payload: unknown) =>
  t.app.inject({ method: 'PUT', url, headers: h, payload: payload as object });
const get = (url: string) => t.app.inject({ url, headers: h });

const supplierForm = {
  region: '07',
  name: 'Ferme du Vexin',
  contact: '',
  street: '',
  postcode: '',
  communeId: null,
  phone: '',
  email: 'ferme@example.org',
  website: '',
  priceListUrl: '',
  active: true,
  publicNotes: '',
  privateNotes: '',
  referentMemberId: null,
  sendsPo: true,
  accountNumber: '',
  minOrderAmount: null,
  paymentTermsDays: 30,
  deliveryDay: 'mardi',
};

async function setup() {
  const s = (await post('/api/v1/suppliers', supplierForm)).json();
  const [p1] = await t.db
    .insert(product)
    .values({
      code: '211001',
      name: 'Miel',
      supplierId: s.id,
      salePrice: '8.00',
      purchasePriceExcl: '5.0000',
      vatRate: '5.50',
      stockQty: '0',
      minStock: '6',
    })
    .returning();
  const [p2] = await t.db
    .insert(product)
    .values({
      code: '211002',
      name: 'Confiture',
      supplierId: s.id,
      salePrice: '4.00',
      purchasePriceExcl: '2.0000',
      vatRate: '5.50',
      stockQty: '5',
      minStock: '2',
    })
    .returning();
  return { s, p1: p1!, p2: p2! };
}

const stockOf = async (id: string) =>
  (await t.db.select().from(product).where(eq(product.id, id)))[0]!.stockQty;

describe('suppliers (R-FNR-01, R-FNR-02)', () => {
  it('proposes the code and creates the 401 account', async () => {
    const a = (await post('/api/v1/suppliers', supplierForm)).json();
    const b = (
      await post('/api/v1/suppliers', { ...supplierForm, name: 'Autre', email: null })
    ).json();
    expect([a.code, b.code]).toEqual(['0701', '0702']);
    const rows = await t.db.select().from(supplier).orderBy(supplier.code);
    expect(rows.map((r) => r.accountNumber)).toEqual(['401001', '401002']);
  });
});

describe('order → receipt cycle (R-CMD-01..06)', () => {
  it('prefills, prints, sends, receives partially then the rest; stock is incremented', async () => {
    const { s, p1, p2 } = await setup();
    const o = (await post('/api/v1/purchase-orders', { supplierId: s.id })).json();
    expect(o.number).toMatch(/^CF-\d{4}-0001$/);
    let detail = (await get(`/api/v1/purchase-orders/${o.id}`)).json();
    // Suggested: Miel 6 − 0 = 6; Confiture 2 − 5 < 0 → not ordered.
    expect(
      detail.lines.map((l: { productId: string; qtyOrdered: string }) => [
        l.productId,
        l.qtyOrdered,
      ]),
    ).toEqual([[p1.id, '6.000']]);
    expect(detail).toMatchObject({ totalExcl: '30.00', totalVat: '1.65', totalIncl: '31.65' });

    // R-CMD-02: quantity 0 removes a line.
    await put(`/api/v1/purchase-orders/${o.id}`, {
      lines: [
        { productId: p1.id, qty: '10', unitPriceExcl: '5' },
        { productId: p2.id, qty: '0', unitPriceExcl: '2' },
      ],
    });
    detail = (await get(`/api/v1/purchase-orders/${o.id}`)).json();
    expect(detail.lines).toHaveLength(1);

    const pdf = await get(`/api/v1/purchase-orders/${o.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    expect(
      (
        await post(`/api/v1/purchase-orders/${o.id}/send`, {
          to: 'ferme@example.org',
          subject: 'Commande',
          message: 'Bonjour',
        })
      ).statusCode,
    ).toBe(200);
    const [mail] = await t.db.select().from(emailOutbox);
    expect((mail!.attachments as { filename: string }[])[0]!.filename).toBe(`${o.number}.pdf`);

    const line = detail.lines[0];
    const r1 = await post(`/api/v1/purchase-orders/${o.id}/receipts`, {
      lines: [{ orderLineId: line.id, productId: p1.id, qty: '4', unitPriceExcl: '5.2' }],
      newSalePrices: { [p1.id]: '8,50' },
    });
    expect(r1.json().number).toMatch(/^RC-\d{4}-0001$/);
    expect((await t.db.select().from(purchaseOrder))[0]!.status).toBe('PARTIAL');
    expect(await stockOf(p1.id)).toBe('4.000');
    const [after] = await t.db.select().from(product).where(eq(product.id, p1.id));
    expect(after).toMatchObject({
      purchasePriceExcl: '5.2000',
      purchasePriceIncl: '5.4860',
      salePrice: '8.50',
      labelPending: true,
    });
    expect(
      (await t.db.select().from(priceHistory).where(eq(priceHistory.productId, p1.id))).map(
        (x) => x.source,
      ),
    ).toEqual(['RECEIPT']);

    // A sale between the two receipts: the second receipt adds to it, never overwrites.
    await recordMovement(t.db, { productId: p1.id, qtyMilli: -1000, kind: 'SALE' });
    await post(`/api/v1/purchase-orders/${o.id}/receipts`, {
      lines: [{ orderLineId: line.id, productId: p1.id, qty: '6', unitPriceExcl: '5.2' }],
    });
    expect((await t.db.select().from(purchaseOrder))[0]!.status).toBe('RECEIVED');
    expect(await stockOf(p1.id)).toBe('9.000');
  });

  it('a partially received order can be closed without its remainder (R-CMD-06)', async () => {
    const { s, p1 } = await setup();
    const o = (await post('/api/v1/purchase-orders', { supplierId: s.id })).json();
    const line = (await get(`/api/v1/purchase-orders/${o.id}`)).json().lines[0];
    await post(`/api/v1/purchase-orders/${o.id}/receipts`, {
      lines: [{ orderLineId: line.id, productId: p1.id, qty: '2', unitPriceExcl: '5' }],
      closeOrder: true,
    });
    expect((await t.db.select().from(purchaseOrder))[0]!.status).toBe('CLOSED');
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/v1/purchase-orders/${o.id}`, headers: h }))
        .statusCode,
    ).toBe(409);
  });
});

describe('stock (R-STK-01..06)', () => {
  it('records a loss, keeps the ledger and the cache equal, values the stock', async () => {
    const { p2 } = await setup();
    await recordMovement(t.db, { productId: p2.id, qtyMilli: 5000, kind: 'INITIAL' });
    expect(
      (await post('/api/v1/stock/losses', { productId: p2.id, qty: '1', reason: 'cassé' }))
        .statusCode,
    ).toBe(200);
    const mv = (await get(`/api/v1/stock/movements?productId=${p2.id}`)).json();
    expect(mv.map((m: { kind: string; balance: string }) => [m.kind, m.balance])).toEqual([
      ['LOSS', '4.000'],
      ['INITIAL', '5.000'],
    ]);
    const [{ sum }] = (await t.db
      .select({ sum: sql<string>`sum(qty)::numeric(12,3)::text` })
      .from(stockMovement)
      .where(eq(stockMovement.productId, p2.id))) as [{ sum: string }];
    expect(sum).toBe('4.000');
    const v = (
      await get(`/api/v1/stock/valuation?date=${toParisDate(new Date())}&basis=excl`)
    ).json();
    expect(v.rows.find((r: { code: string }) => r.code === '211002')).toMatchObject({
      qty: '4.000',
      value: '8.00',
    });
  });

  it('lists the products to reorder (R-PRD-10)', async () => {
    const { p1 } = await setup();
    expect((await get('/api/v1/stock/to-order')).json().map((x: { id: string }) => x.id)).toEqual([
      p1.id,
    ]);
  });
});

describe('inventory (R-STK-04)', () => {
  it('CA: a partial inventory only changes the counted products; a sale meanwhile is not counted twice', async () => {
    const { s, p1, p2 } = await setup();
    await recordMovement(t.db, { productId: p1.id, qtyMilli: 10_000, kind: 'INITIAL' });
    const others = [];
    for (let i = 0; i < 3; i++) {
      const [x] = await t.db
        .insert(product)
        .values({ code: `21100${i + 3}`, name: `P${i}`, supplierId: s.id, stockQty: '0' })
        .returning();
      await recordMovement(t.db, { productId: x!.id, qtyMilli: 3000, kind: 'INITIAL' });
      others.push(x!);
    }
    const inv = (
      await post('/api/v1/inventories', { label: 'Miel', scope: { productIds: [p1.id, p2.id] } })
    ).json();
    let detail = (await get(`/api/v1/inventories/${inv.id}`)).json();
    expect(detail.lines).toHaveLength(2);

    // 2 sold before the count, then counted 7 in two passes (cumulative).
    await recordMovement(t.db, { productId: p1.id, qtyMilli: -2000, kind: 'SALE' });
    await put(`/api/v1/inventories/${inv.id}/lines/${p1.id}`, { mode: 'add', qty: '4' });
    await put(`/api/v1/inventories/${inv.id}/lines/${p1.id}`, { mode: 'add', qty: '3' });
    // A sale after the count does not change the adjustment.
    await recordMovement(t.db, { productId: p1.id, qtyMilli: -1000, kind: 'SALE' });
    detail = (await get(`/api/v1/inventories/${inv.id}`)).json();
    expect(detail.lines.find((l: { productId: string }) => l.productId === p1.id).countedQty).toBe(
      '7.000',
    );

    expect(
      (await post(`/api/v1/inventories/${inv.id}/validate`, { zeroUncounted: false })).json(),
    ).toEqual({ adjusted: 1 });
    // 10 − 2 = 8 expected at count, 7 counted → −1; then −1 sold after → 6.
    expect(await stockOf(p1.id)).toBe('6.000');
    expect(await stockOf(p2.id)).toBe('5.000'); // in scope but not counted: untouched
    for (const x of others) expect(await stockOf(x.id)).toBe('3.000'); // out of scope

    const report = (await get(`/api/v1/inventories/${inv.id}/report`)).json();
    expect(report.rows).toEqual([
      expect.objectContaining({ productId: p1.id, adjustment: '-1.000', valueExcl: '-5.00' }),
    ]);
    expect(report.uncounted).toBe(1);
  });

  it('sets the uncounted products to zero only when asked', async () => {
    const { p2 } = await setup();
    await recordMovement(t.db, { productId: p2.id, qtyMilli: 0, kind: 'INITIAL' });
    const inv = (await post('/api/v1/inventories', { label: 'Tout', scope: {} })).json();
    await post(`/api/v1/inventories/${inv.id}/validate`, { zeroUncounted: true });
    expect(await stockOf(p2.id)).toBe('0.000');
  });
});

describe('invoices (R-FAC-01, R-FAC-02, R-FAC-05)', () => {
  it('computes the due date, links receipts, flags duplicates and alerts at J−3', async () => {
    const { s, p1 } = await setup();
    const r = (
      await post('/api/v1/receipts', {
        supplierId: s.id,
        lines: [{ orderLineId: null, productId: p1.id, qty: '10', unitPriceExcl: '5' }],
      })
    ).json();
    const date = toParisDate(new Date());
    const form = {
      supplierId: s.id,
      pieceRef: 'F-001',
      date,
      totalExcl: '50',
      totalVat: '2,75',
      paymentMethod: 'TRANSFER',
      comment: '',
      receiptIds: [r.id],
    };
    const inv = (await post('/api/v1/supplier-invoices', form)).json();
    const detail = (await get(`/api/v1/supplier-invoices/${inv.id}`)).json();
    expect(detail).toMatchObject({
      dueDate: addDays(date, 30),
      totalIncl: '52.75',
      receivedTotal: '52.75',
      difference: '0.00',
    });

    expect((await post('/api/v1/supplier-invoices', form)).statusCode).toBe(409);
    const check = (
      await post('/api/v1/supplier-invoices/check', {
        supplierId: s.id,
        pieceRef: 'F-002',
        date,
        totalIncl: '52.75',
      })
    ).json();
    expect(check.duplicates.map((d: { id: string }) => d.id)).toEqual([inv.id]);

    // J−3 alert: only when a treasurer address is set, once per invoice.
    await put(`/api/v1/supplier-invoices/${inv.id}`, { ...form, dueDate: addDays(date, 2) });
    expect(await sendDueInvoiceAlerts(t.db)).toBe(0);
    await t.db
      .insert(setting)
      .values({ key: 'pos.treasurerEmail', value: { email: 'tresorier@example.org' } });
    expect(await sendDueInvoiceAlerts(t.db)).toBe(1);
    expect(await sendDueInvoiceAlerts(t.db)).toBe(0);

    const pdf = Buffer.from('%PDF-1.4 test');
    const up = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/supplier-invoices/${inv.id}/document`,
      headers: { ...h, 'content-type': 'application/pdf' },
      payload: pdf,
    });
    expect(up.statusCode).toBe(200);
    expect(
      (await post(`/api/v1/supplier-invoices/${inv.id}/pay`, { date, method: 'TRANSFER' }))
        .statusCode,
    ).toBe(200);
    expect((await get('/api/v1/supplier-invoices/schedule')).json()).toHaveLength(0);
  });
});

describe('catalogue administration (R-PRD-06, R-PRD-08)', () => {
  it('applies a bulk price grid and prints labels', async () => {
    const { s, p1, p2 } = await setup();
    const grid = (await get(`/api/v1/suppliers/${s.id}/price-grid`)).json();
    expect(grid).toHaveLength(2);
    const res = await post('/api/v1/products/bulk-prices', {
      rows: [
        {
          productId: p1.id,
          purchasePriceExcl: '5.5',
          vatRate: '5.50',
          salePrice: '9',
          active: true,
        },
        {
          productId: p2.id,
          purchasePriceExcl: '2',
          vatRate: '5.50',
          salePrice: '4',
          active: false,
        },
      ],
    });
    expect(res.json()).toEqual({ changed: 2 });
    const [a] = await t.db.select().from(product).where(eq(product.id, p1.id));
    const [b] = await t.db.select().from(product).where(eq(product.id, p2.id));
    expect(a).toMatchObject({ salePrice: '9.00', labelPending: true });
    expect(b!.status).toBe('INACTIVE');

    const labels = await post('/api/v1/products/labels/pdf', {
      productIds: [p1.id, p2.id],
      markDone: true,
    });
    expect(labels.headers['content-type']).toBe('application/pdf');
    expect(labels.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await t.db.select().from(product).where(eq(product.id, p1.id)))[0]!.labelPending).toBe(
      false,
    );
  });
});
