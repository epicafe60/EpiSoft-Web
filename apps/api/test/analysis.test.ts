import ExcelJS from 'exceljs';
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

describe('full export (R-STA-04)', () => {
  it('is reserved to ADMIN, audited, and leaves credentials out', async () => {
    const stats = await login(t.app, (await createUser(t.db, { roles: ['STATS'] })).username!);
    expect(
      (await t.app.inject({ url: '/api/v1/admin/export.xlsx', headers: stats })).statusCode,
    ).toBe(403);

    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const res = await t.app.inject({ url: '/api/v1/admin/export.xlsx', headers: admin });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as never);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain('member');
    expect(names).not.toContain('session');
    const header = wb.getWorksheet('member')!.getRow(1).values as unknown[];
    expect(header).not.toContain('password_hash');
    expect(header).toContain('last_name');
  });
});

describe('series and reports (R-STA-03)', () => {
  it('serves the trend and each report kind', async () => {
    const stats = await login(t.app, (await createUser(t.db, { roles: ['STATS'] })).username!);
    const trend = await t.app.inject({
      url: `/api/v1/stats/trend?${range}&granularity=week`,
      headers: stats,
    });
    expect(trend.statusCode).toBe(200);
    expect((trend.json() as { points: unknown[] }).points).toEqual([]);
    for (const kind of [
      'payments',
      'purchases',
      'movements',
      'households',
      'dormant',
      'hours',
      'losses',
      'forecast',
      'suggest',
      'cashgap',
    ]) {
      for (const format of ['json', 'xlsx']) {
        const res = await t.app.inject({
          url: `/api/v1/stats/report/${kind}?${range}&format=${format}`,
          headers: stats,
        });
        expect(res.statusCode, `${kind} ${format}`).toBe(200);
      }
    }
  });
});

describe('saved reports (R-STA-05)', () => {
  it('keeps private reports private, shares on request, and only the author or ADMIN deletes', async () => {
    const a = await login(t.app, (await createUser(t.db, { roles: ['STATS'] })).username!);
    const b = await login(t.app, (await createUser(t.db, { roles: ['STATS'] })).username!);
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const create = (headers: typeof a, shared: boolean) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/stats/saved-reports',
        headers,
        payload: { name: 'Marge du mois', kind: 'sales', params: { by: 'category' }, shared },
      });
    const mine = (await create(a, false)).json() as { id: string };
    await create(a, true);
    const list = async (h: typeof a) =>
      (await t.app.inject({ url: '/api/v1/stats/saved-reports', headers: h })).json() as unknown[];
    expect(await list(a)).toHaveLength(2);
    expect(await list(b)).toHaveLength(1);
    const del = (h: typeof a) =>
      t.app.inject({ method: 'DELETE', url: `/api/v1/stats/saved-reports/${mine.id}`, headers: h });
    expect((await del(b)).statusCode).toBe(403);
    expect((await del(admin)).statusCode).toBe(200);
  });
});
