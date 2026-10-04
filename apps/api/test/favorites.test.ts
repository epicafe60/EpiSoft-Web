import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { product } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('shop favourites', () => {
  it('are private to each member, idempotent, and removable', async () => {
    const [p] = await t.db
      .insert(product)
      .values({ code: 'FAV1', name: 'Miel', salePrice: '5.00', saleCondition: 'ON_ORDER' })
      .returning();
    const a = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const b = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, headers: typeof a) =>
      t.app.inject({ method, url: `/api/v1${url}`, headers });

    expect((await call('GET', '/shop/favorites', a)).json()).toEqual([]);
    expect((await call('PUT', `/shop/favorites/${p!.id}`, a)).statusCode).toBe(200);
    // Idempotent: a second tap does not fail or duplicate.
    expect((await call('PUT', `/shop/favorites/${p!.id}`, a)).statusCode).toBe(200);
    expect((await call('GET', '/shop/favorites', a)).json()).toEqual([p!.id]);
    expect((await call('GET', '/shop/favorites', b)).json()).toEqual([]);

    expect(
      (await call('PUT', '/shop/favorites/00000000-0000-7000-8000-000000000000', a)).statusCode,
    ).toBe(404);
    await call('DELETE', `/shop/favorites/${p!.id}`, b); // not b's: nothing happens
    expect((await call('GET', '/shop/favorites', a)).json()).toEqual([p!.id]);
    await call('DELETE', `/shop/favorites/${p!.id}`, a);
    expect((await call('GET', '/shop/favorites', a)).json()).toEqual([]);
    expect((await t.app.inject({ url: '/api/v1/shop/favorites' })).statusCode).toBe(401);
  });
});
