import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { household, member, walletEntry } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('my household', () => {
  it('shows the caller their own balance and nobody else’s', async () => {
    const a = await createUser(t.db, { roles: [] });
    const b = await createUser(t.db, { roles: [] });
    const [ha] = await t.db.insert(household).values({}).returning();
    const [hb] = await t.db.insert(household).values({}).returning();
    await t.db.update(member).set({ householdId: ha!.id }).where(eq(member.id, a.id));
    await t.db.update(member).set({ householdId: hb!.id }).where(eq(member.id, b.id));
    await t.db.insert(walletEntry).values({ householdId: ha!.id, amount: '12.50', kind: 'TOPUP' });
    await t.db.insert(walletEntry).values({ householdId: hb!.id, amount: '99.00', kind: 'TOPUP' });

    const res = await t.app.inject({
      url: '/api/v1/me/household',
      headers: await login(t.app, a.username!),
    });
    expect(res.statusCode).toBe(200);
    const { household: h } = res.json();
    expect(h.balance).toBe('12.50');
    expect(h.wallet).toHaveLength(1);
    expect(h.members.map((m: { id: string }) => m.id)).toEqual([a.id]);
  });
});
