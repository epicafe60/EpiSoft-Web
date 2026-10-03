import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const range = 'from=2020-01-01&to=2099-12-31';

describe('sales analysis (R-STA-03)', () => {
  it('is reserved to STATS and groups by every axis', async () => {
    const stats = await login(t.app, (await createUser(t.db, { roles: ['STATS'] })).username!);
    const till = await login(t.app, (await createUser(t.db, { roles: ['CAISSE'] })).username!);

    const denied = await t.app.inject({
      url: `/api/v1/stats/analysis?${range}`,
      headers: till,
    });
    expect(denied.statusCode).toBe(403);

    for (const by of ['product', 'category', 'universe', 'supplier', 'day', 'month']) {
      const res = await t.app.inject({
        url: `/api/v1/stats/analysis?${range}&by=${by}`,
        headers: stats,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { rows: unknown[]; total: { marginCents: number } };
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.total.marginCents).toBe(0);
    }
  });

  it('exports to Excel', async () => {
    const stats = await login(t.app, (await createUser(t.db, { roles: ['STATS'] })).username!);
    const res = await t.app.inject({
      url: `/api/v1/stats/analysis?${range}&format=xlsx`,
      headers: stats,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});
