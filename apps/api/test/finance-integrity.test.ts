import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  entry,
  household,
  householdBalance,
  member,
  product,
  stockMovement,
  syncRejection,
  walletEntry,
} from '@episoft/db';
import type { SyncOp } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// Corrections of the KV2 audit, lot B (money and stock): C01, C02, C03, C04, C06.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});

async function addHousehold(balance = '0') {
  const [h] = await t.db.insert(household).values({}).returning();
  const [m] = await t.db
    .insert(member)
    .values({ firstName: 'Anne', lastName: 'FOYER', householdId: h!.id, status: 'ACTIVE' })
    .returning();
  if (balance !== '0')
    await t.db
      .insert(walletEntry)
      .values({ householdId: h!.id, amount: balance, kind: 'CORRECTION' });
  return { householdId: h!.id, memberId: m!.id };
}

const balanceOf = async (householdId: string) =>
  (
    await t.db.select().from(householdBalance).where(eq(householdBalance.householdId, householdId))
  )[0]!.balance;

const stockOf = async (productId: string) =>
  (await t.db.select().from(product).where(eq(product.id, productId)))[0]!.stockQty;

/** A sale of one product at 1 € with the given payment, for a member. */
function saleWith(productId: string, payment: object, memberId: string | null = null): SyncOp {
  const op = till.saleOp([{ productId, unitPrice: '1.00' }], '1.00');
  if (op.kind !== 'SALE') throw new Error('sale expected');
  return {
    ...op,
    payload: { ...op.payload, memberId, payments: [payment] as never },
  };
}

const post = (url: string, payload: object, h = till.admin) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

describe('C01 — change into the cagnotte comes only from the cash given', () => {
  it('credits exactly the change of a cash payment', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    const { householdId, memberId } = await addHousehold();
    const [r] = await till.push([
      saleWith(
        p.id,
        { method: 'CASH', amount: '1.00', tendered: '5.00', change: '4.00', changeToWallet: true },
        memberId,
      ),
    ]);
    expect(r).toMatchObject({ status: 'OK' });
    expect(await balanceOf(householdId)).toBe('4.00');
  });

  it('refuses the case of the audit (1 € paid, 1 € given, 1 000 € of change) and keeps it', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    const { householdId, memberId } = await addHousehold();
    const bad = saleWith(
      p.id,
      { method: 'CASH', amount: '1.00', tendered: '1.00', change: '1000.00', changeToWallet: true },
      memberId,
    );
    const [r] = await till.push([bad]);
    expect(r).toMatchObject({ status: 'REJECTED' });
    expect(r!.error).toMatch(/Règlement incohérent/);
    expect(await balanceOf(householdId)).toBe('0.00');
    expect(await stockOf(p.id)).toBe('10.000');
    // Kept for the administrators, never lost silently.
    const kept = await t.db.select().from(syncRejection).where(eq(syncRejection.opId, bad.id));
    expect(kept).toHaveLength(1);
  });

  it('refuses change on a card payment, and change that does not add up', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    const { householdId, memberId } = await addHousehold();
    const results = await till.push([
      saleWith(
        p.id,
        { method: 'CARD', amount: '1.00', tendered: '1.00', change: '50.00', changeToWallet: true },
        memberId,
      ),
      saleWith(p.id, { method: 'CASH', amount: '1.00', tendered: '10.00', change: '20.00' }),
      saleWith(p.id, { method: 'CASH', amount: '1.00', tendered: '0.50', change: '-0.50' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['REJECTED', 'REJECTED', 'REJECTED']);
    expect(await balanceOf(householdId)).toBe('0.00');
  });

  it('credits the change once when the till sends the same ticket again', async () => {
    // The answer was lost (network cut): the till sends the ticket a second time.
    const p = await addProduct(t.db, { stockQty: '10' });
    const { householdId, memberId } = await addHousehold();
    const op = saleWith(
      p.id,
      { method: 'CASH', amount: '1.00', tendered: '5.00', change: '4.00', changeToWallet: true },
      memberId,
    );
    const [first] = await till.push([op]);
    const [again] = await till.push([op]);
    expect(again).toEqual(first);
    expect(await balanceOf(householdId)).toBe('4.00');
    expect(await stockOf(p.id)).toBe('9.000');
  });

  it('still accepts the payments a till sends every day', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    const results = await till.push([
      saleWith(p.id, { method: 'CASH', amount: '1.00' }),
      saleWith(p.id, { method: 'CASH', amount: '1.00', tendered: '1.00', change: '0.00' }),
      saleWith(p.id, { method: 'CASH', amount: '1.00', tendered: '2.00', change: '1.00' }),
      saleWith(p.id, { method: 'CARD', amount: '1.00' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['OK', 'OK', 'OK', 'OK']);
  });
});

describe('C03 — the imported balance belongs to the household', () => {
  const header = Array.from({ length: 14 }, (_, i) => `H${i}`).join(';');
  const row = (first: string, last: string, balance: string) => {
    const c = Array.from({ length: 14 }, () => '');
    c[1] = balance;
    c[2] = first;
    c[3] = last;
    return c.join(';');
  };
  const send = async (rows: string[], h: Record<string, string>, apply = true) =>
    (
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/imports/members/${apply ? 'apply?confirmBalance=true' : 'preview'}`,
        payload: Buffer.from([header, ...rows].join('\n'), 'utf-8'),
        headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': 'm.csv' },
      })
    ).json();

  async function twoMembersHousehold(balance: string) {
    const { householdId, memberId } = await addHousehold(balance);
    const [second] = await t.db
      .insert(member)
      .values({ firstName: 'Paul', lastName: 'FOYER', householdId, status: 'ACTIVE' })
      .returning();
    return { householdId, firstId: memberId, secondId: second!.id };
  }

  it('reaches the target once when two members of the household carry it (the audit case)', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const { householdId } = await twoMembersHousehold('50.00');
    const result = await send([row('Anne', 'FOYER', '100,00'), row('Paul', 'FOYER', '100,00')], h);
    expect(result.balanceCorrections).toBe(1);
    expect(await balanceOf(householdId)).toBe('100.00');
    // Imported again: already at the target, nothing more.
    expect(
      (await send([row('Anne', 'FOYER', '100,00'), row('Paul', 'FOYER', '100,00')], h))
        .balanceCorrections,
    ).toBe(0);
    expect(await balanceOf(householdId)).toBe('100.00');
  });

  it('refuses two different targets for the same household, and applies neither', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const { householdId } = await twoMembersHousehold('50.00');
    const preview = await send(
      [row('Anne', 'FOYER', '100,00'), row('Paul', 'FOYER', '80,00')],
      h,
      false,
    );
    expect(preview.counts.error).toBe(2);
    await send([row('Anne', 'FOYER', '100,00'), row('Paul', 'FOYER', '80,00')], h);
    expect(await balanceOf(householdId)).toBe('50.00');
  });

  it('measures the gap on the balance at the time of the import, after a sale', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const { householdId } = await twoMembersHousehold('50.00');
    // A purchase with the cagnotte between the preview and the import.
    await send([row('Anne', 'FOYER', '100,00')], h, false);
    await t.db.insert(walletEntry).values({ householdId, amount: '-7.00', kind: 'PURCHASE' });
    await send([row('Anne', 'FOYER', '100,00')], h);
    expect(await balanceOf(householdId)).toBe('100.00');
  });
});

describe('C04 — a sale already counted by a validated inventory', () => {
  it('is not taken off the stock a second time when it arrives after the validation', async () => {
    const p = await addProduct(t.db, { stockQty: '6' });
    const inv = (
      await post('/inventories', { label: 'Miel', scope: { productIds: [p.id] } })
    ).json();
    // Sold offline after the opening; the product is counted at 5 (it is gone) before the sale
    // arrives. The date comes from the database clock, the one that dates the inventory: the clock
    // of the Docker container may drift from the clock of the test process.
    const { rows } = await t.db.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const soldAt = new Date(rows[0]!.now);
    const late = till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50', soldAt);
    await new Promise((r) => setTimeout(r, 20));
    await t.app.inject({
      method: 'PUT',
      url: `/api/v1/inventories/${inv.id}/lines/${p.id}`,
      headers: till.admin,
      payload: { mode: 'set', qty: '5' },
    });
    expect(
      (await post(`/inventories/${inv.id}/validate`, { zeroUncounted: false })).statusCode,
    ).toBe(200);
    expect(await stockOf(p.id)).toBe('5.000');
    // The sale arrives: the stock stays at the count, with a traced regularization.
    const [r] = await till.push([late]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('INVENTORY_LATE_SALE');
    expect(await stockOf(p.id)).toBe('5.000');
    // Sent again (answer lost): nothing more is taken off nor given back.
    expect((await till.push([late]))[0]).toEqual(r);
    expect(await stockOf(p.id)).toBe('5.000');
    const moves = await t.db
      .select({
        kind: stockMovement.kind,
        qty: stockMovement.qty,
        source: stockMovement.sourceType,
      })
      .from(stockMovement)
      .where(eq(stockMovement.productId, p.id));
    expect(moves.map((m) => [m.kind, m.qty]).sort()).toEqual(
      [
        ['INITIAL', '6.000'],
        ['INVENTORY', '-1.000'],
        ['INVENTORY', '1.000'],
        ['SALE', '-1.000'],
      ].sort(),
    );
  });

  it('is counted once when it is recorded during the validation itself', async () => {
    // The sale has taken the product off the stock but is not recorded yet when the validation
    // runs. The validation used to miss its movement and the sale to miss the validation: the
    // product was taken off twice (stock 4 for 5 on the shelf).
    const p = await addProduct(t.db, { stockQty: '6' });
    const { householdId, memberId } = await addHousehold('10.00');
    const inv = (
      await post('/inventories', { label: 'Miel', scope: { productIds: [p.id] } })
    ).json();
    const { rows } = await t.db.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const op = saleWith(p.id, { method: 'WALLET', amount: '1.00' }, memberId);
    if (op.kind !== 'SALE') throw new Error('sale expected');
    const soldAt = new Date(rows[0]!.now).toISOString();
    const late: SyncOp = { ...op, payload: { ...op.payload, soldAt } };
    await new Promise((r) => setTimeout(r, 20));
    await t.app.inject({
      method: 'PUT',
      url: `/api/v1/inventories/${inv.id}/lines/${p.id}`,
      headers: till.admin,
      payload: { mode: 'set', qty: '5' },
    });
    let pushing: ReturnType<Till['push']> | undefined;
    let validating: ReturnType<typeof post> | undefined;
    await t.db.transaction(async (tx) => {
      // Holds the sale after its stock movement (it waits for the cagnotte of the household).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'wallet:' + householdId}))`);
      pushing = till.push([late]);
      await new Promise((r) => setTimeout(r, 400));
      validating = post(`/inventories/${inv.id}/validate`, { zeroUncounted: false });
      await new Promise((r) => setTimeout(r, 400));
    });
    expect((await pushing!)[0]!.status).toBe('OK');
    expect((await validating!).statusCode).toBe(200);
    expect(await stockOf(p.id)).toBe('5.000');
  });

  it('a sale made after the count still lowers the stock', async () => {
    const p = await addProduct(t.db, { stockQty: '6' });
    const inv = (
      await post('/inventories', { label: 'Miel', scope: { productIds: [p.id] } })
    ).json();
    await t.app.inject({
      method: 'PUT',
      url: `/api/v1/inventories/${inv.id}/lines/${p.id}`,
      headers: till.admin,
      payload: { mode: 'set', qty: '6' },
    });
    await post(`/inventories/${inv.id}/validate`, { zeroUncounted: false });
    await new Promise((r) => setTimeout(r, 20));
    // Dated by the database clock, as the count (see above).
    const { rows } = await t.db.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const [r] = await till.push([
      till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50', new Date(rows[0]!.now)),
    ]);
    expect(r!.warnings.map((w) => w.code)).not.toContain('INVENTORY_LATE_SALE');
    expect(await stockOf(p.id)).toBe('5.000');
  });
});

describe('C02 — tickets that arrive after the closing', () => {
  const close = () =>
    post(
      `/pos/sessions/${till.sessionId}/close`,
      {
        denominations: { '10000': 1 },
        bankDeposit: '0',
        chequesCount: 0,
        chequesTotal: '0',
        cardTotalDeclared: '0',
        comment: 'clôture de test',
      },
      till.cashier,
    );
  const sessionsRow = async () =>
    (
      (await t.app.inject({ url: '/api/v1/pos/sessions', headers: till.admin })).json() as {
        id: string;
        lateSales: number;
      }[]
    ).find((s) => s.id === till.sessionId)!;

  it('regenerates the draft entry and the expected cash', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    expect((await close()).statusCode).toBe(200);
    // A ticket of the same session arrives after the closing.
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '3.00' }], '3.00')]);
    expect((await sessionsRow()).lateSales).toBe(1);

    const res = await post(`/pos/sessions/${till.sessionId}/regularize`, {});
    expect(res.statusCode, res.body).toBe(200);
    // 100 € of float + 5,50 € of cash sales expected; 100 € counted.
    expect(res.json()).toMatchObject({
      expectedCash: '105.50',
      difference: '-5.50',
      accounting: 'regenerated',
    });
    expect((await sessionsRow()).lateSales).toBe(0);
    const [e] = await t.db
      .select()
      .from(entry)
      .where(and(eq(entry.sourceType, 'session'), eq(entry.sourceId, till.sessionId)));
    expect(e).toBeDefined();
  });

  it('adds a balanced regularization entry when the closing entry is validated', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    expect((await close()).statusCode).toBe(200);
    const compta = await login(t.app, (await createUser(t.db, { roles: ['COMPTA'] })).username!);
    const [e] = await t.db.select().from(entry).where(eq(entry.sourceId, till.sessionId));
    const v = await post('/entries/validate', { ids: [e!.id] }, compta);
    expect(v.statusCode, v.body).toBe(200);

    await till.push([till.saleOp([{ productId: p.id, unitPrice: '3.00' }], '3.00')]);
    const res = await post(`/pos/sessions/${till.sessionId}/regularize`, {}, compta);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().accounting).toBe('regularized');
    // The validated entry is untouched; the regularization balances.
    const [still] = await t.db.select().from(entry).where(eq(entry.id, e!.id));
    expect(still!.status).toBe('VALIDATED');
    const { rows } = await t.db.execute<{ d: string; c: string }>(sql`
      select sum(l.debit)::text as d, sum(l.credit)::text as c from app.entry_line l
      join app.entry e on e.id = l.entry_id where e.source_type = 'session_regularization'`);
    expect(rows[0]!.d).toBe(rows[0]!.c);
    expect(Number(rows[0]!.d)).toBeGreaterThan(0);
    // Nothing more to do the second time.
    expect(
      (await post(`/pos/sessions/${till.sessionId}/regularize`, {}, compta)).json().accounting,
    ).toBe('unchanged');
  });

  it('is reserved to the administrators and the treasury', async () => {
    expect((await close()).statusCode).toBe(200);
    const res = await post(`/pos/sessions/${till.sessionId}/regularize`, {}, till.cashier);
    expect(res.statusCode).toBe(403);
  });

  it('never loses a ticket recorded while the closing is being written', async () => {
    // The audit's « vente concurrente à la clôture ». The ticket used to read the session as
    // open, wait, and be written in the closed session with a time before the closing: counted
    // neither by the closing nor as arrived after it.
    const p = await addProduct(t.db, { stockQty: '10' });
    let pushing: Promise<Awaited<ReturnType<Till['push']>>> | undefined;
    await t.db.transaction(async (tx) => {
      // A closing in progress holds the session.
      await tx.execute(sql`select 1 from app.cash_session where id = ${till.sessionId} for update`);
      pushing = till.push([till.saleOp([{ productId: p.id, unitPrice: '3.00' }], '3.00')]);
      await new Promise((r) => setTimeout(r, 500));
      await tx.execute(
        sql`update app.cash_session set status = 'CLOSED', closed_at = clock_timestamp()
            where id = ${till.sessionId}`,
      );
    });
    const [r] = await pushing!;
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('SESSION_CLOSED');
    expect((await sessionsRow()).lateSales).toBe(1);
  });

  it('flags a till top-up arrived after the closing, and counts it once regularized', async () => {
    const { householdId } = await addHousehold();
    expect((await close()).statusCode).toBe(200);
    const [r] = await till.push([
      {
        kind: 'WALLET_TOPUP',
        id: randomUUID(),
        deviceSeq: till.nextSeq(),
        payload: {
          sessionId: till.sessionId,
          cashierId: till.cashierId,
          householdId,
          amount: '20.00',
          method: 'CASH',
          at: new Date().toISOString(),
          emailReceipt: false,
        },
      },
    ]);
    expect(r!.status).toBe('OK');
    expect((await sessionsRow()).lateSales).toBe(1);
    const res = await post(`/pos/sessions/${till.sessionId}/regularize`, {});
    // 100 € of float + 20 € of cash top-up.
    expect(res.json().expectedCash).toBe('120.00');
    expect((await sessionsRow()).lateSales).toBe(0);
  });
});

describe('a ticket cancelled from two tills at once', () => {
  it('is cancelled once: one refund, one stock return, the other cancellation refused', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    const { householdId, memberId } = await addHousehold('10.00');
    const s = saleWith(p.id, { method: 'WALLET', amount: '1.00' }, memberId);
    expect((await till.push([s]))[0]!.status).toBe('OK');
    const cancel = (): SyncOp => {
      const n = till.nextSeq();
      return {
        kind: 'SALE_CANCEL',
        id: randomUUID(),
        deviceSeq: n,
        payload: {
          cancelSaleId: randomUUID(),
          saleId: s.id,
          sessionId: till.sessionId,
          cashierId: till.cashierId,
          at: new Date().toISOString(),
          provisionalNumber: `CAISSE1-${n}`,
        },
      };
    };
    const results = (await Promise.all([till.push([cancel()]), till.push([cancel()])])).flat();
    expect(results.map((x) => x.status).sort()).toEqual(['OK', 'REJECTED']);
    expect(results.find((x) => x.status === 'REJECTED')!.error).toMatch(/déjà annulé/);
    expect(await balanceOf(householdId)).toBe('10.00');
    expect(await stockOf(p.id)).toBe('10.000');
    // The refusal alerts the administrators in the background: let it finish before the next test
    // empties the tables.
    await expect
      .poll(
        async () =>
          (
            await t.db.execute<{ n: number }>(
              sql`select count(*)::int as n from app.email_outbox where subject like '%refusé%'`,
            )
          ).rows[0]!.n,
      )
      .toBeGreaterThan(0);
  });
});

describe('C06 — the till dates its sent operations with the server time', () => {
  it('the push answer gives the server time', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    const before = Date.now();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: till.cashier,
      payload: {
        deviceId: till.deviceId,
        ops: [till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')],
      },
    });
    const { serverTime } = res.json() as { serverTime: string };
    expect(new Date(serverTime).getTime()).toBeGreaterThanOrEqual(before);
  });
});
