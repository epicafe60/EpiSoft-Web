import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLog, priceHistory, product, purchaseOrder, supplier } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct } from './till-fixtures';

// « Passer une commande »: last ordered quantity, start at 0, PA HT carried over to the product.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`truncate app.goods_receipt_line, app.goods_receipt,
    app.purchase_order_line, app.purchase_order, app.price_history, app.number_counter cascade`);
  h = await login(t.app, (await createUser(t.db, { roles: ['APPROS', 'PRODUITS'] })).username!);
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });

async function setup() {
  await t.db.execute(sql`delete from app.supplier`);
  const [s] = await t.db.insert(supplier).values({ code: 'FQ', name: 'Fournisseur Q' }).returning();
  const p = await addProduct(t.db, {
    supplierId: s!.id,
    name: 'Miel',
    stockQty: '0',
    minStock: '6',
    purchasePriceExcl: '5.0000',
    purchaseVatAmount: '0.2750',
    purchasePriceIncl: '5.2750',
    vatRate: '5.50',
  });
  return { s: s!, p };
}

const newOrder = async (supplierId: string, date?: string) =>
  (await call('POST', '/purchase-orders', { supplierId, date })).json() as { id: string };
const detail = async (id: string) =>
  (await call('GET', `/purchase-orders/${id}`)).json() as {
    lines: { productId: string; lastOrderedQty: string | null }[];
  };
const offered = async (id: string) =>
  (await call('GET', `/purchase-orders/${id}/supplier-products`)).json() as {
    productId: string;
    lastOrderedQty: string | null;
  }[];

describe('a new order starts at zero', () => {
  it('has no line even when the stock is under the minimum; the list still gives the suggestion', async () => {
    const { s, p } = await setup();
    const o = await newOrder(s.id);
    expect((await detail(o.id)).lines).toEqual([]);
    const rows = await offered(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productId: p.id, suggestedQty: '6.000', lastOrderedQty: null });
  });
});

describe('quantité dernière commande', () => {
  it('is the quantity of the most recent order of the supplier, not counting cancelled or current ones', async () => {
    const { s, p } = await setup();
    const put = (id: string, qty: string) =>
      call('PUT', `/purchase-orders/${id}`, {
        lines: [{ productId: p.id, qty, unitPriceExcl: '5' }],
      });
    const old = await newOrder(s.id, '2026-01-10');
    await put(old.id, '3');
    const recent = await newOrder(s.id, '2026-03-10');
    await put(recent.id, '8');
    const cancelled = await newOrder(s.id, '2026-05-10');
    await put(cancelled.id, '99');
    expect((await call('POST', `/purchase-orders/${cancelled.id}/cancel`)).statusCode).toBe(200);

    const current = await newOrder(s.id, '2026-06-10');
    expect((await offered(current.id))[0]!.lastOrderedQty).toBe('8.000');
    await put(current.id, '4');
    // On the order itself, its own quantity is not « the last one ».
    expect((await detail(current.id)).lines[0]!.lastOrderedQty).toBe('8.000');
    // On the oldest order, the more recent ones are not « previous », only the others: 8 is the
    // latest of the other orders (cancelled excluded).
    expect((await detail(old.id)).lines[0]!.lastOrderedQty).toBe('4.000');
  });
});

describe('PA HT unitaire typed in the order follows the product sheet', () => {
  it('updates the product price (HT, with VAT amount and TTC kept consistent), history and audit; unchanged price touches nothing', async () => {
    const { s, p } = await setup();
    const o = await newOrder(s.id);
    // Same price: nothing changes.
    await call('PUT', `/purchase-orders/${o.id}`, {
      lines: [{ productId: p.id, qty: '2', unitPriceExcl: '5' }],
    });
    expect(await t.db.select().from(priceHistory)).toHaveLength(0);

    const res = await call('PUT', `/purchase-orders/${o.id}`, {
      lines: [{ productId: p.id, qty: '2', unitPriceExcl: '5.4' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const [after] = await t.db.select().from(product).where(eq(product.id, p.id));
    // The VAT amount and the TTC follow the HT at the rate of the product: 5.4 x 1.055.
    expect(after).toMatchObject({
      purchasePriceExcl: '5.4000',
      purchaseVatAmount: '0.2970',
      purchasePriceIncl: '5.6970',
    });
    const hist = await t.db.select().from(priceHistory);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ productId: p.id, purchasePriceExcl: '5.4000', source: 'FORM' });
    const entries = await t.db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'product.update' and ${auditLog.entityId} = ${p.id}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.before).toMatchObject({ purchasePriceExcl: '5.0000' });
    expect(entries[0]!.after).toMatchObject({ purchasePriceExcl: '5.4000' });
  });

  it('a line at quantity 0 does not touch the product, and an empty or invalid price is refused', async () => {
    const { s, p } = await setup();
    const o = await newOrder(s.id);
    await call('PUT', `/purchase-orders/${o.id}`, {
      lines: [{ productId: p.id, qty: '0', unitPriceExcl: '9' }],
    });
    expect(
      (await t.db.select().from(product).where(eq(product.id, p.id)))[0]!.purchasePriceExcl,
    ).toBe('5.0000');
    for (const unitPriceExcl of ['', 'abc']) {
      const bad = await call('PUT', `/purchase-orders/${o.id}`, {
        lines: [{ productId: p.id, qty: '1', unitPriceExcl }],
      });
      expect(bad.statusCode).toBe(400);
    }
    expect(await t.db.select().from(purchaseOrder)).toHaveLength(1);
  });
});
