import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pushSubscription } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';
import { sendPush } from '../src/lib/push';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'BKey', auth: 'secret' } });

describe('web push subscriptions', () => {
  it('reports push as unavailable without VAPID keys, and sends nothing', async () => {
    const u = await createUser(t.db, { roles: [] });
    const h = await login(t.app, u.username!);
    const key = await t.app.inject({ url: '/api/v1/push/key', headers: h });
    expect(key.json()).toEqual({ publicKey: null });
    expect(await sendPush(t.db, t.config, u.id, { title: 'x', body: 'y' })).toBe(0);
  });

  it('keeps one row per device, and only the owner can remove it', async () => {
    const a = await createUser(t.db, { roles: [] });
    const b = await createUser(t.db, { roles: [] });
    const ha = await login(t.app, a.username!);
    const hb = await login(t.app, b.username!);
    const post = (url: string, headers: typeof ha, payload: object) =>
      t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });

    expect((await post('/push/subscribe', ha, sub('https://push.example/1'))).statusCode).toBe(200);
    await post('/push/subscribe', ha, sub('https://push.example/1'));
    expect(await t.db.select().from(pushSubscription)).toHaveLength(1);
    expect((await post('/push/subscribe', ha, { endpoint: 'nope', keys: {} })).statusCode).toBe(
      400,
    );

    await post('/push/unsubscribe', hb, { endpoint: 'https://push.example/1' });
    expect(await t.db.select().from(pushSubscription)).toHaveLength(1);
    await post('/push/unsubscribe', ha, { endpoint: 'https://push.example/1' });
    expect(
      await t.db.select().from(pushSubscription).where(eq(pushSubscription.memberId, a.id)),
    ).toHaveLength(0);
  });

  it('requires a session', async () => {
    expect((await t.app.inject({ url: '/api/v1/push/key' })).statusCode).toBe(401);
  });
});
