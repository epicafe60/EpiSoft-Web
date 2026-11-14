import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cashSession, product, sale, stockMovement, syncRejection } from '@episoft/db';
import type { SyncOp } from '@episoft/shared';
import { setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// Review of November 2026: what a till declares is checked by the server (M3, M4, F2, F3).

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});
// A refused operation alerts the administrators in the background: wait until the database is
// idle before the next test empties the tables.
afterEach(async () => {
  await expect
    .poll(
      async () =>
        (
          await t.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity
                where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`,
          )
        ).rows[0]!.n,
      { timeout: 5000 },
    )
    .toBe(0);
});

const stockOf = async (productId: string) =>
  (await t.db.select().from(product).where(eq(product.id, productId)))[0]!.stockQty;

describe('M3 — the time recorded is never in the future', () => {
  it('records a ticket dated a year ahead at the server’s time, and says so', async () => {
    const p = await addProduct(t.db);
    const nextYear = new Date(Date.now() + 366 * 86_400_000);
    const op = till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50', nextYear);
    const [r] = await till.push([op]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('CLOCK_SKEW');
    const [s] = await t.db.select().from(sale).where(eq(sale.id, op.id));
    // The number carries the year of the server, not the one the till made up.
    expect(s!.number).toContain(`T-${new Date().getFullYear()}-`);
    expect(Math.abs(s!.soldAt.getTime() - Date.now())).toBeLessThan(60_000);
    const [m] = await t.db.select().from(stockMovement).where(eq(stockMovement.sourceId, op.id));
    expect(Math.abs(m!.at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('keeps a ticket sold offline a few hours ago at its own time', async () => {
    const p = await addProduct(t.db);
    const earlier = new Date(Date.now() - 3 * 3_600_000);
    const op = till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50', earlier);
    const [r] = await till.push([op]);
    expect(r!.status).toBe('OK');
    const [s] = await t.db.select().from(sale).where(eq(sale.id, op.id));
    expect(s!.soldAt.toISOString()).toBe(earlier.toISOString());
  });

  it('reports an operation dated before the opening of its session', async () => {
    const p = await addProduct(t.db);
    const op = till.saleOp(
      [{ productId: p.id, unitPrice: '2.50' }],
      '2.50',
      new Date(Date.now() - 3 * 86_400_000),
    );
    const [r] = await till.push([op]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('CLOCK_BEFORE_SESSION');
  });
});

describe('M4 — the float of a drawer and the top-ups at the till', () => {
  const open = (floatAmount: string): SyncOp => ({
    kind: 'SESSION_OPEN',
    id: randomUUID(),
    deviceSeq: till.nextSeq(),
    payload: {
      sessionId: randomUUID(),
      openedBy: till.cashierId,
      openedAt: new Date().toISOString(),
      openingFloat: floatAmount,
    },
  });

  it('refuses a negative float, in the code and in the database', async () => {
    await t.db.execute(sql`delete from app.cash_session`);
    const [r] = await till.push([open('-50.00')]);
    expect(r!.status).toBe('REJECTED');
    expect(r!.error).toContain('négatif');
    expect(await t.db.select().from(syncRejection)).toHaveLength(1);
    await expect(
      t.db.insert(cashSession).values({
        id: randomUUID(),
        deviceId: till.deviceId,
        openedAt: new Date(),
        openingFloat: '-1.00',
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('flags a large top-up without refusing it', async () => {
    const { household, member } = await import('@episoft/db');
    const [h] = await t.db.insert(household).values({}).returning();
    await t.db
      .insert(member)
      .values({ firstName: 'Anne', lastName: 'FOYER', householdId: h!.id, status: 'ACTIVE' });
    const [r] = await till.push([
      {
        kind: 'WALLET_TOPUP',
        id: randomUUID(),
        deviceSeq: till.nextSeq(),
        payload: {
          sessionId: till.sessionId,
          cashierId: till.cashierId,
          householdId: h!.id,
          amount: '900.00',
          method: 'CASH',
          at: new Date().toISOString(),
          emailReceipt: false,
        },
      },
    ]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('TOPUP_HIGH');
  });
});

describe('F2 — a person the server does not know is refused, not an error', () => {
  it('refuses a sale of an unknown cashier and lets the next operation through', async () => {
    const p = await addProduct(t.db);
    const bad = till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50');
    if (bad.kind !== 'SALE') throw new Error('sale expected');
    bad.payload.cashierId = randomUUID();
    const good = till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50');
    const [a, b] = await till.push([bad, good]);
    expect(a!.status).toBe('REJECTED');
    expect(a!.error).toContain('inconnu');
    expect(b!.status).toBe('OK');
    // Sent again: the same answer, nothing blocks the queue.
    expect((await till.push([bad]))[0]).toEqual(a);
  });

  it('refuses a session opened by an unknown person', async () => {
    await t.db.execute(sql`delete from app.cash_session`);
    const [r] = await till.push([
      {
        kind: 'SESSION_OPEN',
        id: randomUUID(),
        deviceSeq: till.nextSeq(),
        payload: {
          sessionId: randomUUID(),
          openedBy: randomUUID(),
          openedAt: new Date().toISOString(),
          openingFloat: '100.00',
        },
      },
    ]);
    expect(r!.status).toBe('REJECTED');
  });
});

describe('F3 — a cancellation that arrives after an inventory counted the product', () => {
  it('does not put the product back on the stock a second time', async () => {
    const p = await addProduct(t.db, { stockQty: '6' });
    const sold = till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50');
    expect((await till.push([sold]))[0]!.status).toBe('OK');
    expect(await stockOf(p.id)).toBe('5.000');

    // An inventory opens, counts the product (5: the sale is gone) and is validated.
    const inv = (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/inventories',
        headers: till.admin,
        payload: { label: 'Miel', scope: { productIds: [p.id] } },
      })
    ).json();
    // The cancellation was made at the till just after the opening, offline.
    const { rows } = await t.db.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const cancelledAt = new Date(rows[0]!.now);
    await new Promise((r) => setTimeout(r, 20));
    await t.app.inject({
      method: 'PUT',
      url: `/api/v1/inventories/${inv.id}/lines/${p.id}`,
      headers: till.admin,
      payload: { mode: 'set', qty: '6' },
    });
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/inventories/${inv.id}/validate`,
          headers: till.admin,
          payload: { zeroUncounted: false },
        })
      ).statusCode,
    ).toBe(200);
    // Counted at 6: the shelf already held the product the till had given back.
    expect(await stockOf(p.id)).toBe('6.000');

    const [r] = await till.push([
      {
        kind: 'SALE_CANCEL',
        id: randomUUID(),
        deviceSeq: till.nextSeq(),
        payload: {
          cancelSaleId: randomUUID(),
          saleId: sold.id,
          sessionId: till.sessionId,
          cashierId: till.cashierId,
          at: cancelledAt.toISOString(),
          provisionalNumber: 'CAISSE1-ANN',
        },
      },
    ]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('INVENTORY_LATE_CANCEL');
    expect(await stockOf(p.id)).toBe('6.000');
  });
});
