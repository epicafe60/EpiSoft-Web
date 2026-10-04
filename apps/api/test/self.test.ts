import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  cashSession,
  household,
  member,
  posDevice,
  product,
  sale,
  saleLine,
  salePayment,
  walletEntry,
} from '@episoft/db';
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

  it('opens a ticket of the own household only', async () => {
    const a = await createUser(t.db, { roles: [] });
    const b = await createUser(t.db, { roles: [] });
    const [ha] = await t.db.insert(household).values({}).returning();
    const [hb] = await t.db.insert(household).values({}).returning();
    await t.db.update(member).set({ householdId: ha!.id }).where(eq(member.id, a.id));
    await t.db.update(member).set({ householdId: hb!.id }).where(eq(member.id, b.id));
    const [dev] = await t.db.insert(posDevice).values({ name: 'D1' }).returning();
    const [ses] = await t.db
      .insert(cashSession)
      .values({
        id: crypto.randomUUID(),
        deviceId: dev!.id,
        openedAt: new Date(),
        openingFloat: '0',
      })
      .returning();
    const [p] = await t.db
      .insert(product)
      .values({ code: 'P1', name: 'Pain', salePrice: '2.50' })
      .returning();
    const mk = async (n: string, householdId: string) => {
      const [x] = await t.db
        .insert(sale)
        .values({
          id: crypto.randomUUID(),
          number: n,
          sessionId: ses!.id,
          householdId,
          soldAt: new Date(),
          total: '5.00',
        })
        .returning();
      await t.db.insert(saleLine).values({
        saleId: x!.id,
        lineNo: 1,
        productId: p!.id,
        label: 'Pain',
        qty: '2',
        unitPrice: '2.5',
        lineTotal: '5.00',
      });
      await t.db.insert(salePayment).values({ saleId: x!.id, method: 'WALLET', amount: '5.00' });
      return x!;
    };
    const mine = await mk('T-2026-000001', ha!.id);
    const theirs = await mk('T-2026-000002', hb!.id);
    const h = await login(t.app, a.username!);
    const ok = await t.app.inject({ url: `/api/v1/me/tickets/${mine.id}`, headers: h });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      number: 'T-2026-000001',
      total: '5.00',
      lines: [{ label: 'Pain', qty: '2.000', lineTotal: '5.00' }],
      payments: [{ method: 'WALLET', amount: '5.00' }],
    });
    expect(
      (await t.app.inject({ url: `/api/v1/me/tickets/${theirs.id}`, headers: h })).statusCode,
    ).toBe(404);
  });
});
