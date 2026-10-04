import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { product } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';
import { recordMovement } from '../src/modules/stock/ledger';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

type Check = {
  id: string;
  count: number;
  samples: { ref: string; link: string | null }[];
  fix: { label: string } | null;
  accepted: { ref: string; note: string | null }[];
  ackable: boolean;
};

async function setup() {
  const u = await createUser(t.db, { roles: ['ADMIN'] });
  const h = await login(t.app, u.username!);
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });
  const check = async (id: string) =>
    ((await call('GET', '/admin/integrity')).json().checks as Check[]).find((c) => c.id === id)!;
  return { call, check };
}

describe('integrity: detailed analysis', () => {
  it('every check that announces an analysis can produce its table (JSON and Excel)', async () => {
    const { call } = await setup();
    const checks = (await call('GET', '/admin/integrity')).json().checks as {
      id: string;
      analysis: boolean;
    }[];
    const withAnalysis = checks.filter((c) => c.analysis);
    expect(withAnalysis.length).toBeGreaterThanOrEqual(15);
    for (const c of withAnalysis) {
      const res = await call('GET', `/admin/integrity/${c.id}/analysis`);
      expect(res.statusCode, c.id).toBe(200);
      const table = res.json();
      expect(table.columns.length, c.id).toBeGreaterThan(2);
      expect(table.subtitle.length, c.id).toBeGreaterThan(40);
    }
    const xlsx = await call('GET', '/admin/integrity/STK-01/analysis?format=xlsx');
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((await call('GET', '/admin/integrity/ZZZ-99/analysis')).statusCode).toBe(404);
  });

  it('the stock analysis shows both sides of a gap', async () => {
    const { call } = await setup();
    await t.db
      .insert(product)
      .values({ code: 'AN1', name: 'Farine', salePrice: '2', stockQty: '5.000' });
    const table = (await call('GET', '/admin/integrity/STK-01/analysis')).json();
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].cells).toMatchObject({
      product: 'AN1 · Farine',
      cache: '5.000',
      moves: '0',
      gap: '5.000',
    });
    // Each row links to its item (opened in a new tab by the screen).
    expect(table.rows[0].link).toMatch(/^\/catalogue\/[0-9a-f-]{36}$/);
  });
});

describe('integrity: links and remediation', () => {
  it('explains every check: what it compares and what to do', async () => {
    const { call } = await setup();
    const checks = (await call('GET', '/admin/integrity')).json().checks as {
      id: string;
      help: { what: string; todo: string };
    }[];
    expect(checks.length).toBeGreaterThan(10);
    for (const c of checks) {
      expect(c.help.what.length, c.id).toBeGreaterThan(40);
      expect(c.help.todo.length, c.id).toBeGreaterThan(40);
      // The generic fallback must not be used: each check has its own text.
      expect(c.help.what, c.id).not.toMatch(/^Contrôle automatique de cohérence/);
    }
  });

  it('links an offending item and recomputes a stale stock cache from the movements', async () => {
    const { call, check } = await setup();
    const [p] = await t.db
      .insert(product)
      .values({ code: 'ST1', name: 'Pain', salePrice: '2', stockQty: '5.000' })
      .returning();
    // 5 in the cache but no movement behind it.
    const bad = await check('STK-01');
    expect(bad.count).toBe(1);
    expect(bad.samples[0]).toMatchObject({ ref: 'ST1', link: `/catalogue/${p!.id}` });
    expect(bad.fix?.label).toContain('Recalculer');

    const res = await call('POST', '/admin/integrity/STK-01/fix');
    expect(res.json()).toEqual({ fixed: 1 });
    expect((await check('STK-01')).count).toBe(0);
    const [after] = await t.db.select().from(product).where(eq(product.id, p!.id));
    expect(after!.stockQty).toBe('0.000');
    expect((await call('POST', '/admin/integrity/CAG-01/fix')).statusCode).toBe(404);
    expect((await call('POST', '/admin/integrity/VTE-04/fix')).json()).toEqual({ fixed: 0 });
  });

  it('a reviewed warning can be accepted, listed as accepted, and taken back; errors cannot', async () => {
    const { call, check } = await setup();
    const [neg] = await t.db
      .insert(product)
      .values({ code: 'NEG1', name: 'Lait', salePrice: '1' })
      .returning();
    await recordMovement(t.db, { productId: neg!.id, qtyMilli: -3000, kind: 'CORRECTION' });
    const open = await check('STK-05');
    expect(open).toMatchObject({ count: 1, ackable: true });

    expect(
      (
        await call('POST', '/admin/integrity/accept', {
          checkId: 'STK-05',
          ref: 'NEG1',
          note: 'Inventaire prévu lundi',
        })
      ).statusCode,
    ).toBe(200);
    const accepted = await check('STK-05');
    expect(accepted.count).toBe(0);
    expect(accepted.accepted).toEqual([
      expect.objectContaining({ ref: 'NEG1', note: 'Inventaire prévu lundi' }),
    ]);

    await call('POST', '/admin/integrity/unaccept', { checkId: 'STK-05', ref: 'NEG1' });
    expect((await check('STK-05')).count).toBe(1);

    const err = await call('POST', '/admin/integrity/accept', { checkId: 'STK-01', ref: 'X' });
    expect(err.statusCode).toBe(400);
  });

  it('is reserved to ADMIN and COMPTA', async () => {
    const u = await createUser(t.db, { roles: ['CAISSE'] });
    const h = await login(t.app, u.username!);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/integrity/STK-01/fix',
      headers: h,
    });
    expect(res.statusCode).toBe(403);
  });
});
