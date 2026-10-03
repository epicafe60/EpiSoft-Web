import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  emailOutbox,
  household,
  member,
  membership,
  membershipType,
  setting,
  walletEntry,
} from '@episoft/db';
import { addDays } from '@episoft/shared';
import { toParisDate } from '../src/lib/dates';
import { sendMembershipReminders } from '../src/modules/members/reminders';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let headers: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`truncate app.wallet_entry, app.member_payment, app.membership cascade`);
  const u = await createUser(t.db, { roles: ['ADHERENTS'] });
  headers = await login(t.app, u.username!);
});

async function household1() {
  const [h] = await t.db.insert(household).values({}).returning();
  const [m] = await t.db
    .insert(member)
    .values({
      firstName: 'Ana',
      lastName: 'B',
      householdId: h!.id,
      email: `ana${h!.number}@example.org`,
    })
    .returning();
  await t.db.update(household).set({ referentMemberId: m!.id }).where(eq(household.id, h!.id));
  return h!;
}

describe('R-ADH-04 membership reminder', () => {
  it('sends once, only when enabled, only to households that have not renewed', async () => {
    const [annual] = await t.db
      .select()
      .from(membershipType)
      .where(eq(membershipType.code, 'ANNUAL'));
    const today = toParisDate(new Date());
    const due = await household1();
    const renewed = await household1();
    await t.db.insert(membership).values([
      {
        householdId: due.id,
        typeId: annual!.id,
        startDate: addDays(today, -355),
        endDate: addDays(today, 10),
        amount: '12',
      },
      {
        householdId: renewed.id,
        typeId: annual!.id,
        startDate: addDays(today, -355),
        endDate: addDays(today, 10),
        amount: '12',
      },
      {
        householdId: renewed.id,
        typeId: annual!.id,
        startDate: addDays(today, 11),
        endDate: addDays(today, 375),
        amount: '12',
      },
    ]);
    expect(await sendMembershipReminders(t.db)).toBe(0); // disabled by default
    await t.db
      .insert(setting)
      .values({ key: 'membership.reminder', value: { enabled: true, daysBefore: 15 } });
    expect(await sendMembershipReminders(t.db)).toBe(1);
    expect(await sendMembershipReminders(t.db)).toBe(0);
    const mails = await t.db.select().from(emailOutbox);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('adhésion');
  });
});

describe('R-CAG-08 same-day cancellation of a top-up', () => {
  it('cancels today’s back-office top-up, refuses a correction', async () => {
    const h = await household1();
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/households/${h.id}/wallet/topup`,
      headers,
      payload: { amount: '20', method: 'CASH', emailReceipt: false },
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/households/${h.id}/wallet/correction`,
      headers,
      payload: { amount: '-1', comment: 'erreur' },
    });
    const detail = (await t.app.inject({ url: `/api/v1/households/${h.id}`, headers })).json();
    const topup = detail.wallet.find((w: { kind: string }) => w.kind === 'TOPUP');
    const correction = detail.wallet.find((w: { kind: string }) => w.kind === 'CORRECTION');
    expect(topup.cancellable).toBe(true);
    expect(correction.cancellable).toBe(false);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/wallet-entries/${correction.id}/cancel`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/wallet-entries/${topup.id}/cancel`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const left = await t.db.select().from(walletEntry).where(eq(walletEntry.householdId, h.id));
    expect(left.map((w) => w.kind)).toEqual(['CORRECTION']);
  });

  it('refuses a top-up from a previous day', async () => {
    const h = await household1();
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/households/${h.id}/wallet/topup`,
      headers,
      payload: { amount: '20', method: 'CASH', emailReceipt: false },
    });
    await t.db.execute(
      sql`update app.wallet_entry set created_at = created_at - interval '2 days'`,
    );
    const [e] = await t.db.select().from(walletEntry);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/wallet-entries/${e!.id}/cancel`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('R-CAG-07 history export', () => {
  it('exports an Excel file and e-mails the history', async () => {
    const h = await household1();
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/households/${h.id}/wallet/topup`,
      headers,
      payload: { amount: '20', method: 'CASH', emailReceipt: false },
    });
    const x = await t.app.inject({ url: `/api/v1/households/${h.id}/wallet.xlsx`, headers });
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/households/${h.id}/wallet/email`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(await t.db.select().from(emailOutbox)).toHaveLength(1);
  });
});
