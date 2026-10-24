import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, setupTestApp } from './helpers';

// A stuck loop (a script, a stuck browser tab) must not be able to read the whole database
// again and again: the heavy exports are limited to a few a minute.

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('rate limits', () => {
  it('stops a loop on the personal data export after ten a minute', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++)
      codes.push((await t.app.inject({ url: '/api/v1/me/export', headers: h })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('stops a loop on the full database export after ten a minute', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push((await t.app.inject({ url: '/api/v1/admin/export.xlsx', headers: h })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
