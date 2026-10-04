import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailOutbox, product } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('pre-order ready e-mail (R-PRE-02)', () => {
  it('queues one e-mail to the customer when the order becomes ready', async () => {
    const [jam] = await t.db
      .insert(product)
      .values({ code: 'JAM1', name: 'Confiture', salePrice: '4.00', saleCondition: 'ON_ORDER' })
      .returning();
    const customer = await createUser(t.db, { roles: [], email: 'client@example.org' });
    const staff = await createUser(t.db, { roles: ['COMMANDES_GESTION'] });
    const ch = await login(t.app, customer.username!);
    const sh = await login(t.app, staff.username!);
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(
      new Date(Date.now() + 86_400_000),
    );
    const { id, number } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/preorders',
        headers: ch,
        payload: { pickupDate: day, lines: [{ productId: jam!.id, qty: '1' }] },
      })
    ).json();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/preorders/${id}/status`,
      headers: sh,
      payload: { status: 'READY' },
    });
    expect(res.statusCode).toBe(200);
    const mails = await t.db.select().from(emailOutbox);
    expect(mails.filter((m) => m.to === 'client@example.org' && m.subject.includes(number))).toHaveLength(1);
  });
});
