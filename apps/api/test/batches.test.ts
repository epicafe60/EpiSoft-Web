import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { product } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('R-STK-07 best-before batches', () => {
  it('lists by date with status, discards into the ledger, removes without loss', async () => {
    const [p] = await t.db
      .insert(product)
      .values({ code: 'YAO1', name: 'Yaourt', salePrice: '1.00' })
      .returning();
    const h = await login(t.app, (await createUser(t.db, { roles: ['APPROS'] })).username!);
    const noRole = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const call = (method: 'GET' | 'POST' | 'DELETE', url: string, headers = h, payload?: object) =>
      t.app.inject({ method, url: `/api/v1${url}`, headers, payload });

    await call('POST', '/stock/batches', h, { productId: p!.id, bestBefore: iso(-2), qty: '3' });
    await call('POST', '/stock/batches', h, { productId: p!.id, bestBefore: iso(3), qty: '2' });
    await call('POST', '/stock/batches', h, { productId: p!.id, bestBefore: iso(40), qty: '5' });
    expect(
      (await call('POST', '/stock/batches', h, { productId: p!.id, bestBefore: iso(1), qty: '0' }))
        .statusCode,
    ).toBe(400);
    expect((await call('GET', '/stock/batches', noRole)).statusCode).toBe(403);

    const all = (await call('GET', '/stock/batches')).json() as {
      id: string;
      status: string;
      daysLeft: number;
    }[];
    expect(all.map((b) => b.status)).toEqual(['EXPIRED', 'SOON', 'OK']);
    expect(all[0]!.daysLeft).toBe(-2);
    expect((await call('GET', '/stock/batches?days=7')).json()).toHaveLength(2);

    // Discarding books a LOSS movement of the batch quantity.
    await call('DELETE', `/stock/batches/${all[0]!.id}?discard=true`);
    const mv = (await call('GET', `/stock/movements?productId=${p!.id}`)).json() as {
      kind: string;
      qty: string;
    }[];
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ kind: 'LOSS', qty: '-3.000' });

    // Plain removal leaves the ledger alone.
    await call('DELETE', `/stock/batches/${all[1]!.id}`);
    expect((await call('GET', `/stock/movements?productId=${p!.id}`)).json()).toHaveLength(1);
    expect((await call('GET', '/stock/batches')).json()).toHaveLength(1);
    expect((await call('DELETE', `/stock/batches/${all[1]!.id}`)).statusCode).toBe(404);
  });
});
