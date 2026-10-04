import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { product } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('product reviews', () => {
  it('stay private until a PRODUITS user approves them', async () => {
    const [p] = await t.db
      .insert(product)
      .values({ code: 'REV1', name: 'Miel', salePrice: '5.00', saleCondition: 'ON_ORDER' })
      .returning();
    const a = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const b = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const mod = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
    const call = (
      method: 'GET' | 'PUT' | 'POST',
      url: string,
      headers: typeof a,
      payload?: object,
    ) => t.app.inject({ method, url: `/api/v1${url}`, headers, payload });

    expect((await call('PUT', `/shop/products/${p!.id}/review`, a, { rating: 9 })).statusCode).toBe(
      400,
    );
    expect(
      (await call('PUT', `/shop/products/${p!.id}/review`, a, { rating: 5, comment: 'Délicieux' }))
        .statusCode,
    ).toBe(200);
    // Edit instead of duplicate.
    await call('PUT', `/shop/products/${p!.id}/review`, a, { rating: 4, comment: 'Très bon' });

    // Pending: the author sees it, others do not, no public rating yet.
    const own = (await call('GET', `/shop/products/${p!.id}/reviews`, a)).json();
    expect(own.reviews).toHaveLength(1);
    expect(own.reviews[0]).toMatchObject({ mine: true, status: 'PENDING', rating: 4 });
    expect((await call('GET', `/shop/products/${p!.id}/reviews`, b)).json().reviews).toHaveLength(
      0,
    );
    expect((await call('GET', '/shop/ratings', b)).json()).toEqual({});
    expect((await call('GET', '/reviews/pending', a)).statusCode).toBe(403);

    const pending = (await call('GET', '/reviews/pending', mod)).json() as { id: string }[];
    expect(pending).toHaveLength(1);
    await call('POST', `/reviews/${pending[0]!.id}/moderate`, mod, { status: 'APPROVED' });

    const seen = (await call('GET', `/shop/products/${p!.id}/reviews`, b)).json();
    expect(seen).toMatchObject({ average: 4, count: 1 });
    expect(seen.reviews[0].comment).toBe('Très bon');
    expect((await call('GET', '/shop/ratings', b)).json()).toEqual({
      [p!.id]: { average: 4, count: 1 },
    });
  });
});
