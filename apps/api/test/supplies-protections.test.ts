import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditLog, supplier } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

// Protections of the supplies side: a purchase price that jumps, more received than ordered.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`truncate app.invoice_receipt, app.supplier_invoice, app.goods_receipt_line,
    app.goods_receipt, app.purchase_order_line, app.purchase_order, app.stock_movement,
    app.price_history, app.number_counter, app.product_barcode cascade`);
  await t.db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
  await t.db.execute(sql`delete from app.supplier`);
  h = await login(t.app, (await createUser(t.db, { roles: ['APPROS', 'PRODUITS'] })).username!);
});

const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });

const product = (extra: object = {}) => ({
  name: 'Lentilles',
  description: null,
  kind: 'GOODS',
  saleMode: 'UNIT',
  unitQty: null,
  unit: null,
  saleCondition: 'ON_SITE',
  shopVisible: true,
  categoryId: null,
  supplierId: null,
  supplierRef: null,
  qualities: [],
  vatRate: '5.50',
  status: 'ACTIVE',
  purchasePriceExcl: '10.0000',
  salePrice: '15.00',
  minStock: null,
  eans: [],
  posTabId: null,
  posLabel: null,
  posSort: 0,
  code: '970001',
  ...extra,
});

async function orderOf(qty: string, price: string, productExtra: object = {}) {
  const [s] = await t.db.insert(supplier).values({ code: 'FP', name: 'Fournisseur P' }).returning();
  const created = await call('POST', '/products', product({ supplierId: s!.id, ...productExtra }));
  const { id: productId } = created.json() as { id: string };
  const o = await call('POST', '/purchase-orders', {
    supplierId: s!.id,
    lines: [{ productId, qty, unitPriceExcl: price }],
  });
  const { id } = o.json() as { id: string };
  const detail = (await call('GET', `/purchase-orders/${id}`)).json() as {
    lines: { id: string; purchasePriceExcl: string | null }[];
  };
  return { id, productId, lineId: detail.lines[0]!.id, detail };
}

describe('receiving goods: what changes without notice is now said', () => {
  it('gives the receive screen the last purchase price of each product', async () => {
    const o = await orderOf('5', '10.0000');
    expect(o.detail.lines[0]!.purchasePriceExcl).toBe('10.0000');
  });

  it('warns of a purchase price that jumped and of more received than ordered, and journals it', async () => {
    const o = await orderOf('5', '10.0000');
    const res = await call('POST', `/purchase-orders/${o.id}/receipts`, {
      lines: [
        { orderLineId: o.lineId, productId: o.productId, qty: '8', unitPriceExcl: '15.0000' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const { warnings } = res.json() as { warnings: string[] };
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain('+50 %');
    expect(warnings.join(' ')).toContain('plus que commandé');
    expect(warnings.every((w) => !/R-[A-Z]{3}-\d/.test(w))).toBe(true);

    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'receipt.create'`);
    expect((entry!.after as { warnings: string[] }).warnings).toHaveLength(2);
  });

  it('says nothing about a normal receipt', async () => {
    const o = await orderOf('5', '10.0000');
    const res = await call('POST', `/purchase-orders/${o.id}/receipts`, {
      lines: [
        { orderLineId: o.lineId, productId: o.productId, qty: '5', unitPriceExcl: '10.5000' },
      ],
    });
    expect(res.json().warnings).toEqual([]);
  });

  it('flags a purchase price at 0 €', async () => {
    const o = await orderOf('5', '10.0000');
    const res = await call('POST', `/purchase-orders/${o.id}/receipts`, {
      lines: [{ orderLineId: o.lineId, productId: o.productId, qty: '5', unitPriceExcl: '0' }],
    });
    expect(res.json().warnings.join(' ')).toContain('à 0 €');
  });

  it('points at a product whose name is almost the same, never at itself', async () => {
    const created = await call('POST', '/products', product({ name: 'Lentilles vertes du Puy' }));
    const { id } = created.json() as { id: string };
    const similar = async (name: string, exceptId?: string) =>
      (
        await call(
          'GET',
          `/products/similar?${new URLSearchParams({ name, ...(exceptId ? { exceptId } : {}) })}`,
        )
      ).json() as { id: string; name: string }[];
    expect((await similar('LENTILLES VERTES DU PUY')).map((p) => p.id)).toEqual([id]);
    expect((await similar('Lentilles vertes du Pui')).map((p) => p.id)).toEqual([id]);
    expect(await similar('Lentilles vertes du Puy', id)).toEqual([]);
    expect(await similar('Riz basmati')).toEqual([]);
  });

  it('serves the thresholds to every signed-in user, and to nobody else', async () => {
    const res = await call('GET', '/controls/thresholds');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ qtyMax: 50, purchaseVariationPct: 20, cashGap: 5 });
    expect((await t.app.inject({ url: '/api/v1/controls/thresholds' })).statusCode).toBe(401);
  });
});
