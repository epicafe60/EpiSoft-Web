import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { product } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  const u = await createUser(t.db, { roles: ['ADMIN'] });
  admin = await login(t.app, u.username!);
});
afterAll(() => t.close());

const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: admin, payload });

describe('ADMIN closes what was left open', () => {
  it('force-closes a session with no count, then refuses a second time', async () => {
    const deviceId = (await call('POST', '/pos/devices', { name: 'POSTE-X' })).json().id;
    const sessionId = randomUUID();
    const push = await call('POST', '/sync/push', {
      deviceId,
      ops: [
        {
          kind: 'SESSION_OPEN',
          id: sessionId,
          deviceSeq: 1,
          payload: {
            sessionId,
            openedBy: (await t.db.execute(sql`select id from app.member limit 1`)).rows[0]!.id,
            openedAt: new Date().toISOString(),
            openingFloat: '100.00',
          },
        },
      ],
    });
    expect(push.json().results[0].status).toBe('OK');

    const res = await call('POST', `/pos/sessions/${sessionId}/force-close`, {
      comment: 'poste perdu',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().difference).toBe('0.00');
    const row = (
      await t.db.execute(sql`select status from app.cash_session where id = ${sessionId}`)
    ).rows[0];
    expect(row).toMatchObject({ status: 'CLOSED' });
    expect(
      (await call('POST', `/pos/sessions/${sessionId}/force-close`, { comment: 'encore' }))
        .statusCode,
    ).toBe(409);
  });

  it('closes a pre-order as collected without the till', async () => {
    const [jam] = await t.db
      .insert(product)
      .values({ code: '999001', name: 'Miel', salePrice: '5.00', saleCondition: 'BOTH' })
      .returning();
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(
      new Date(Date.now() + 86_400_000),
    );
    const { id } = (
      await call('POST', '/preorders', {
        pickupDate: day,
        lines: [{ productId: jam!.id, qty: '1' }],
      })
    ).json();
    expect(
      (await call('POST', `/preorders/${id}/status`, { status: 'PICKED_UP' })).statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/preorders/${id}/status`, { status: 'CANCELLED' })).statusCode,
    ).toBe(409);
  });
});
