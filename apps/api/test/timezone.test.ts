import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appTimeZone, setAppTimeZone, type OperationRow } from '@episoft/shared';
import { toShopDate } from '../src/lib/dates';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// The time zone of the shop is a setting: it decides which calendar day a moment belongs to.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});
afterEach(() => setAppTimeZone('Europe/Paris'));

const day = (tz: string, d = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d);

describe('app.timezone', () => {
  it('is Europe/Paris until the association sets its own', async () => {
    expect(appTimeZone()).toBe('Europe/Paris');
    const info = (await t.app.inject({ url: '/api/v1/branding' })).json();
    expect(info.timeZone).toBe('Europe/Paris');
  });

  it('refuses a name that is not a time zone, and is reserved to the administrators', async () => {
    const a = await createUser(t.db, { roles: ['ADMIN'] });
    const admin = await login(t.app, a.username!);
    const put = (headers: Record<string, string>, timeZone: string) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/v1/settings/app.timezone',
        headers,
        payload: { timeZone },
      });
    expect((await put(admin, 'Mars/Olympus')).statusCode).toBe(400);
    expect((await put(admin, "Europe/Paris'; drop table app.member; --")).statusCode).toBe(400);
    expect((await put(till.cashier, 'Europe/Paris')).statusCode).toBe(403);
    expect(appTimeZone()).toBe('Europe/Paris');
  });

  it('moves the day of the operations, the statistics and the dates written by the server', async () => {
    const a = await createUser(t.db, { roles: ['ADMIN'] });
    const admin = await login(t.app, a.username!);
    const goods = await addProduct(t.db, { salePrice: '2.50' });
    const op = till.saleOp([{ productId: goods.id, unitPrice: '2.50' }], '2.50');
    expect((await till.push([op]))[0]!.status).toBe('OK');

    // Kiritimati is 13 hours ahead of Paris: at most hours it is already another day there.
    const zone = 'Pacific/Kiritimati';
    const saved = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/app.timezone',
      headers: admin,
      payload: { timeZone: zone },
    });
    expect(saved.statusCode).toBe(200);
    expect(appTimeZone()).toBe(zone);
    expect(toShopDate(new Date())).toBe(day(zone));
    expect((await t.app.inject({ url: '/api/v1/branding' })).json().timeZone).toBe(zone);

    // The ticket belongs to the day of the configured zone, not to the Paris one.
    const read = async (d: string) =>
      (
        await t.app.inject({ url: `/api/v1/pos/operations?day=${d}`, headers: till.cashier })
      ).json() as OperationRow[];
    expect((await read(day(zone))).filter((r) => r.id === op.id)).toHaveLength(1);
    if (day('Europe/Paris') !== day(zone))
      expect((await read(day('Europe/Paris'))).filter((r) => r.id === op.id)).toHaveLength(0);

    // A statistic by day, written in SQL with the zone, uses it as well.
    const stats = await t.app.inject({
      url: `/api/v1/stats/analysis?from=${day(zone)}&to=${day(zone)}&by=day`,
      headers: admin,
    });
    expect(stats.statusCode).toBe(200);
  });
});
