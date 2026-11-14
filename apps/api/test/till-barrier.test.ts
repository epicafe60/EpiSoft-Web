import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { posDevice } from '@episoft/db';
import { setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// Audit KV2, C02/C04: an inventory is not validated blindly while a till may hold sales it has not
// sent. The tills say who they are and what they hold when they refresh; one that went silent, or
// announces operations, has to be confirmed by the person validating.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});

const post = (url: string, payload: object) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: till.admin, payload });
const deviceRow = async () => (await t.db.select().from(posDevice))[0]!;

async function inventory() {
  const p = await addProduct(t.db, { stockQty: '6' });
  const inv = (await post('/inventories', { label: 'Test', scope: { productIds: [p.id] } })).json();
  await t.app.inject({
    method: 'PUT',
    url: `/api/v1/inventories/${inv.id}/lines/${p.id}`,
    headers: till.admin,
    payload: { mode: 'set', qty: '6' },
  });
  return inv.id as string;
}
const setDevice = (set: string) => t.db.execute(sql.raw(`update app.pos_device set ${set}`));

describe('a till is asked about before an inventory is validated', () => {
  it('learns what the till says when it refreshes its data: who, and how many it still holds', async () => {
    const d = await deviceRow();
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/sync/snapshot?device=${d.id}&pending=3`,
      headers: till.cashier,
    });
    expect(res.statusCode).toBe(200);
    expect(await deviceRow()).toMatchObject({ pendingOps: 3 });
    expect((await deviceRow()).lastContactAt).toBeInstanceOf(Date);
  });

  it('lets a till that is up to date go: validated without any question', async () => {
    await setDevice(`last_contact_at = now(), pending_ops = 0`);
    const id = await inventory();
    expect((await post(`/inventories/${id}/validate`, { zeroUncounted: false })).statusCode).toBe(
      200,
    );
  });

  it('asks for a confirmation when a till in use has gone silent, then lets it through', async () => {
    await setDevice(`last_contact_at = now() - interval '30 minutes', pending_ops = 0`);
    const id = await inventory();
    const refused = await post(`/inventories/${id}/validate`, { zeroUncounted: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'TILLS_NOT_SYNCED' });
    expect(refused.json().detail).toContain((await deviceRow()).name);
    const confirmed = await post(`/inventories/${id}/validate`, {
      zeroUncounted: false,
      confirmUnsyncedTills: true,
    });
    expect(confirmed.statusCode).toBe(200);
  });

  it('asks too when a till that is online announces operations it has not sent', async () => {
    await setDevice(`last_contact_at = now(), pending_ops = 2`);
    const id = await inventory();
    expect((await post(`/inventories/${id}/validate`, { zeroUncounted: false })).json().code).toBe(
      'TILLS_NOT_SYNCED',
    );
  });

  it('does not wait for a till that was put away days ago, nor for one that is switched off', async () => {
    await setDevice(`last_contact_at = now() - interval '3 days', pending_ops = 5`);
    const id = await inventory();
    expect((await post(`/inventories/${id}/validate`, { zeroUncounted: false })).statusCode).toBe(
      200,
    );
    // A deactivated till is not waited for either.
    await setDevice(`last_contact_at = now() - interval '30 minutes', active = false`);
    const again = await inventory();
    expect(
      (await post(`/inventories/${again}/validate`, { zeroUncounted: false })).statusCode,
    ).toBe(200);
    await t.db
      .update(posDevice)
      .set({ active: true })
      .where(eq(posDevice.id, (await deviceRow()).id));
  });

  it('F5: a till that claims to hold nothing, while its numbering is ahead of what the server received, is asked about', async () => {
    const d = await deviceRow();
    const p = await addProduct(t.db, { stockQty: '10' });
    // The server received operation 1 (the opening) and the sale below: 3.
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '1.00' }], '1.00')]);
    const received = (await deviceRow()).receivedSeq;
    expect(received).toBeGreaterThanOrEqual(2);
    const refresh = (seq: number) =>
      t.app.inject({
        method: 'GET',
        url: `/api/v1/sync/snapshot?device=${d.id}&pending=0&seq=${seq}`,
        headers: till.cashier,
      });
    // Up to date: it announces the number the server already has.
    await refresh(received);
    const id = await inventory();
    expect((await post(`/inventories/${id}/validate`, { zeroUncounted: false })).statusCode).toBe(
      200,
    );
    // Ahead by three operations while saying it holds none: confirmation asked.
    await refresh(received + 3);
    const again = await inventory();
    expect(
      (await post(`/inventories/${again}/validate`, { zeroUncounted: false })).json().code,
    ).toBe('TILLS_NOT_SYNCED');
  });

  it('a push counts as a contact', async () => {
    await setDevice(`last_contact_at = null, pending_ops = 0`);
    const p = await addProduct(t.db, { stockQty: '10' });
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '1.00' }], '1.00')]);
    expect((await deviceRow()).lastContactAt).toBeInstanceOf(Date);
  });
});
