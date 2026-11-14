import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { emailOutbox } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

// A form refused by the validation is remembered by route and by the fields at fault, so that an
// administrator sees which form blocks people (a user reported « validation error » on a new
// product with nothing to go on). Names of fields only, never their values.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`truncate app.error_log`);
  h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
});

const post = (url: string, payload: object) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
const refusals = async () =>
  (
    await t.db.execute<{ message: string; route: string; count: number }>(
      sql`select message, route, count from app.error_log order by message`,
    )
  ).rows;
const settle = () =>
  new Promise<void>((resolve) => {
    const poll = async () => {
      const { rows } = await t.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`,
      );
      if (rows[0]!.n === 0) resolve();
      else setTimeout(() => void poll(), 50);
    };
    void poll();
  });

describe('refused entries in Surveillance › Erreurs', () => {
  it('remembers the route and the fields, counts a repeat, and never keeps a value', async () => {
    const secret = 'valeur-secrete-12345';
    for (let i = 0; i < 2; i++)
      expect(
        (await post('/products', { name: secret, salePrice: '', eans: ['123'] })).statusCode,
      ).toBe(400);
    await settle();
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: 'POST /api/v1/products', count: 2 });
    expect(rows[0]!.message).toMatch(/^Saisie refusée : .*eans/);
    expect(rows[0]!.message).toMatch(/salePrice/);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('is not a breakdown: no e-mail, and not counted in « À surveiller »', async () => {
    await post('/products', { name: 'x' });
    await settle();
    expect((await refusals()).length).toBe(1);
    expect(await t.db.select().from(emailOutbox)).toHaveLength(0);
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const attention = (
      await t.app.inject({ method: 'GET', url: '/api/v1/admin/attention', headers: admin })
    ).json() as { code: string }[];
    expect(attention.map((a) => a.code)).not.toContain('SERVER_ERRORS');
  });

  it('records nothing for a request without a session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'x-episoft-csrf': '1' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    await settle();
    expect(await refusals()).toEqual([]);
  });
});
