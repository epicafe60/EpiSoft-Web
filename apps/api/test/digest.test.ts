import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  emailOutbox,
  household,
  member,
  product,
  productBatch,
  setting,
  walletEntry,
} from '@episoft/db';
import { createUser, setupTestApp } from './helpers';
import {
  sendExpiryDigest,
  sendIntegrityAlert,
  sendLowWalletReminders,
} from '../src/modules/admin/digest';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.delete(productBatch);
});

const iso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('R-STK-07 expiry digest', () => {
  it('mails the purchasing team once a day, only when a batch is close', async () => {
    const buyer = await createUser(t.db, { roles: ['APPROS'] });
    await createUser(t.db, { roles: ['CAISSE'] });
    expect(await sendExpiryDigest(t.db, t.config)).toBe(0); // nothing to report
    const [p] = await t.db
      .insert(product)
      .values({ code: 'D1', name: 'Yaourt', salePrice: '1' })
      .returning();
    await t.db.insert(productBatch).values([
      { productId: p!.id, bestBefore: iso(2), qty: '3' },
      { productId: p!.id, bestBefore: iso(60), qty: '3' },
    ]);
    expect(await sendExpiryDigest(t.db, t.config)).toBe(1);
    expect(await sendExpiryDigest(t.db, t.config)).toBe(0); // already sent today
    const mails = await t.db.select().from(emailOutbox);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: buyer.email });
    expect(mails[0]!.text).toContain('Yaourt');
  });
});

describe('R-CAG-06 low cagnotte reminder', () => {
  it('is off by default, then reminds a buying household once per period', async () => {
    const [h] = await t.db.insert(household).values({}).returning();
    const m = await createUser(t.db, { roles: [] });
    await t.db.update(member).set({ householdId: h!.id }).where(eq(member.id, m.id));
    await t.db.update(household).set({ referentMemberId: m.id }).where(eq(household.id, h!.id));
    await t.db.insert(walletEntry).values([
      { householdId: h!.id, amount: '10.00', kind: 'TOPUP' },
      { householdId: h!.id, amount: '-7.00', kind: 'PURCHASE' },
    ]);
    expect(await sendLowWalletReminders(t.db, t.config)).toBe(0); // disabled
    await t.db
      .insert(setting)
      .values({
        key: 'wallet.lowReminder',
        value: { enabled: true, threshold: '5.00', everyDays: 30 },
      });
    expect(await sendLowWalletReminders(t.db, t.config)).toBe(1);
    // Same day: the job already ran. Next day would still be blocked by the 30-day rule.
    expect(await sendLowWalletReminders(t.db, t.config)).toBe(0);
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await sendLowWalletReminders(t.db, t.config, tomorrow)).toBe(0);
    const mails = await t.db.select().from(emailOutbox);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('3,00');
  });

  it('does not remind a household that has not bought recently or is above the threshold', async () => {
    const [rich] = await t.db.insert(household).values({}).returning();
    await t.db.insert(walletEntry).values([
      { householdId: rich!.id, amount: '50.00', kind: 'TOPUP' },
      { householdId: rich!.id, amount: '-1.00', kind: 'PURCHASE' },
    ]);
    const [idle] = await t.db.insert(household).values({}).returning();
    await t.db.insert(walletEntry).values({
      householdId: idle!.id,
      amount: '2.00',
      kind: 'TOPUP',
      at: new Date(Date.now() - 200 * 86_400_000),
    });
    await t.db
      .insert(setting)
      .values({
        key: 'wallet.lowReminder',
        value: { enabled: true, threshold: '5.00', everyDays: 30 },
      });
    expect(await sendLowWalletReminders(t.db, t.config)).toBe(0);
  });
});

describe('integrity alert', () => {
  it('goes to ADMIN and COMPTA once a day, and only on errors', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const report = (errors: number) => ({
      at: new Date().toISOString(),
      errors,
      warnings: 0,
      checks: [
        { id: 'CAG-01', label: 'Solde', severity: 'error' as const, count: errors, samples: [] },
      ],
    });
    expect(await sendIntegrityAlert(t.db, t.config, report(0))).toBe(0);
    expect(await sendIntegrityAlert(t.db, t.config, report(2))).toBe(1);
    expect(await sendIntegrityAlert(t.db, t.config, report(2))).toBe(0);
    expect((await t.db.select().from(emailOutbox))[0]).toMatchObject({ to: admin.email });
  });
});
