import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RoleCode } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

async function dashboard(roles: RoleCode[]) {
  const u = await createUser(t.db, { roles });
  const h = await login(t.app, u.username!);
  const res = await t.app.inject({ url: '/api/v1/stats/dashboard', headers: h });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

describe('dashboard (R-STA-02)', () => {
  it('gives each role only its blocks', async () => {
    const stats = await dashboard(['STATS']);
    expect(Object.keys(stats)).toEqual(
      expect.arrayContaining([
        'sales',
        'payments',
        'topProducts',
        'lowStock',
        'invoicesDue',
        'membershipsExpiring',
      ]),
    );
    expect((stats.sales as unknown[]).length).toBe(4);

    const till = await dashboard(['CAISSE']);
    expect(till.sales).toBeDefined();
    expect(till.invoicesDue).toBeUndefined();
    expect(till.membershipsExpiring).toBeUndefined();

    const nobody = await dashboard([]);
    expect(Object.keys(nobody)).toEqual(['today']);
  });
});
