import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailOutbox } from '@episoft/db';
import { queueEmail } from '../src/lib/mail';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.reset();
  await t.close();
});
beforeEach(() => t.reset());

describe('administration switches: online shop and e-mail sending', () => {
  it('closing the shop refuses the customer routes and tells the app, then reopens', async () => {
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const buyer = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const put = (enabled: boolean) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/v1/settings/shop.enabled',
        headers: admin,
        payload: { enabled },
      });
    const products = () => t.app.inject({ url: '/api/v1/shop/products', headers: buyer });
    const me = async () =>
      (await t.app.inject({ url: '/api/v1/me', headers: buyer })).json().shopEnabled;

    expect(await me()).toBe(true);
    expect((await products()).statusCode).toBe(200);

    expect((await put(false)).statusCode).toBe(200);
    expect(await me()).toBe(false);
    const closed = await products();
    expect(closed.statusCode).toBe(403);
    expect(closed.json().detail).toContain('fermée');
    for (const url of ['/api/v1/shop/favorites', '/api/v1/shop/ratings']) {
      expect((await t.app.inject({ url, headers: buyer })).statusCode).toBe(403);
    }
    const order = await t.app.inject({
      method: 'POST',
      url: '/api/v1/preorders',
      headers: buyer,
      payload: { pickupDate: '2099-01-01', lines: [{ productId: crypto.randomUUID(), qty: '1' }] },
    });
    expect(order.statusCode).toBe(403);
    // Orders already placed stay reachable.
    expect((await t.app.inject({ url: '/api/v1/preorders/mine', headers: buyer })).statusCode).toBe(
      200,
    );

    expect((await put(true)).statusCode).toBe(200);
    expect(await me()).toBe(true);
    expect((await products()).statusCode).toBe(200);
  });

  it('switching e-mail off keeps messages in the outbox as not sent, and drops those waiting', async () => {
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const mail = (subject: string) => ({ to: 'a@b.fr', subject, html: '<p>x</p>', text: 'x' });

    await queueEmail(t.db, mail('actif'));
    const put = (enabled: boolean) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/v1/settings/email.enabled',
        headers: admin,
        payload: { enabled },
      });
    expect((await put(false)).statusCode).toBe(200);
    await queueEmail(t.db, mail('coupé'));

    const rows = await t.db.select().from(emailOutbox);
    const bySubject = Object.fromEntries(rows.map((r) => [r.subject, r]));
    expect(bySubject['actif']!.status).toBe('PENDING');
    expect(bySubject['coupé']).toMatchObject({ status: 'FAILED' });
    expect(bySubject['coupé']!.lastError).toContain('désactivé');

    await put(true);
    await queueEmail(t.db, mail('rétabli'));
    const back = await t.db.select().from(emailOutbox).where(eq(emailOutbox.subject, 'rétabli'));
    expect(back[0]!.status).toBe('PENDING');
  });
});
