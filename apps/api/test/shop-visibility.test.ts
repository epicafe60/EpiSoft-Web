import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { category, product, universe } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const today = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

describe('excluding a product or a shelf from the shop', () => {
  it('hides it from the window and refuses to order it, but keeps the rest', async () => {
    const [u] = await t.db
      .insert(universe)
      .values({ code: 'V9', name: 'Univers test' })
      .returning();
    const [shelf] = await t.db
      .insert(category)
      .values({ universeId: u!.id, code: '91', name: 'Confitures' })
      .returning();
    const mk = (code: string, name: string, extra: object = {}) =>
      t.db
        .insert(product)
        .values({ code, name, salePrice: '4.00', saleCondition: 'ON_ORDER', ...extra })
        .returning()
        .then((r) => r[0]!);
    const jam = await mk('VIS1', 'Confiture', { categoryId: shelf!.id });
    const honey = await mk('VIS2', 'Miel');
    const buyer = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const staff = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);

    const names = async () =>
      (
        (await t.app.inject({ url: '/api/v1/shop/products', headers: buyer })).json() as {
          name: string;
        }[]
      )
        .map((p) => p.name)
        .sort();
    const order = (id: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/preorders',
        headers: buyer,
        payload: { pickupDate: today, lines: [{ productId: id, qty: '1' }] },
      });

    expect(await names()).toEqual(['Confiture', 'Miel']);

    // One product out: the others stay, and it can no longer be ordered.
    await t.db.update(product).set({ shopVisible: false }).where(eq(product.id, honey.id));
    expect(await names()).toEqual(['Confiture']);
    expect((await order(honey.id)).statusCode).toBe(400);
    await t.db.update(product).set({ shopVisible: true }).where(eq(product.id, honey.id));

    // A whole shelf out, through the catalogue screen's own endpoint.
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/categories/${shelf!.id}`,
      headers: staff,
      payload: { universeId: u!.id, code: '91', name: 'Confitures', sort: 0, shopVisible: false },
    });
    expect(put.statusCode).toBe(200);
    expect(await names()).toEqual(['Miel']); // a product without a shelf is unaffected
    expect((await order(jam.id)).statusCode).toBe(400);
    expect((await order(honey.id)).statusCode).toBe(200);

    // Back in.
    await t.app.inject({
      method: 'PUT',
      url: `/api/v1/categories/${shelf!.id}`,
      headers: staff,
      payload: { universeId: u!.id, code: '91', name: 'Confitures', sort: 0, shopVisible: true },
    });
    expect(await names()).toEqual(['Confiture', 'Miel']);
  });
});
