import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  householdBalance,
  household,
  member,
  membership,
  membershipType,
  product,
  productBarcode,
  sale,
  stockMovement,
  walletEntry,
  type Db,
} from '@episoft/db';
import type { SyncOp, SyncResult } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

type Headers = Record<string, string>;
let headers: Headers;
let cashierId: string;
let deviceId: string;
let sessionId: string;
let seq = 0;

async function resetPos(db: Db) {
  await db.execute(sql`truncate app.preorder_line, app.preorder, app.sync_receipt, app.sale_payment, app.sale_line, app.membership, app.wallet_entry,
    app.member_payment, app.sale, app.cash_count, app.cash_session, app.pos_device, app.stock_movement,
    app.product_barcode, app.number_counter cascade`);
  await db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
}

async function addProduct(over: Partial<typeof product.$inferInsert> = {}, ean?: string) {
  const [p] = await t.db
    .insert(product)
    .values({
      code: String(100000 + Math.floor(Math.random() * 899999)),
      name: 'Chips',
      salePrice: '2.50',
      stockQty: '10',
      ...over,
    })
    .returning();
  if (ean) await t.db.insert(productBarcode).values({ ean, productId: p!.id });
  return p!;
}

async function addHousehold(members = 1, balance = '0') {
  const [h] = await t.db.insert(household).values({}).returning();
  const ms = [];
  for (let i = 0; i < members; i++) {
    const [m] = await t.db
      .insert(member)
      .values({
        firstName: `M${i}`,
        lastName: 'FOYER',
        householdId: h!.id,
        status: 'ACTIVE',
        email: `m${i}-${h!.number}@example.org`,
      })
      .returning();
    ms.push(m!);
  }
  if (balance !== '0')
    await t.db
      .insert(walletEntry)
      .values({ householdId: h!.id, amount: balance, kind: 'CORRECTION' });
  return { household: h!, members: ms };
}

const balance = async (householdId: string) =>
  (
    await t.db.select().from(householdBalance).where(eq(householdBalance.householdId, householdId))
  )[0]!.balance;

async function push(ops: SyncOp[], h: Headers = headers): Promise<SyncResult[]> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: h,
    payload: { deviceId, ops },
  });
  if (res.statusCode !== 200) throw new Error(`push ${res.statusCode}: ${res.body}`);
  return res.json().results;
}

function saleOp(
  lines: { productId: string; qty?: string; unitPrice: string; discount?: string }[],
  payments: Record<string, unknown>[],
  opts: { memberId?: string | null; total?: string; sessionId?: string; forcedBy?: string } = {},
): SyncOp {
  seq++;
  const total =
    opts.total ??
    (
      lines.reduce(
        (s, l) =>
          s +
          Math.round(Number(l.qty ?? '1') * Number(l.unitPrice) * 100) -
          Math.round(Number(l.discount ?? '0') * 100),
        0,
      ) / 100
    ).toFixed(2);
  return {
    kind: 'SALE',
    id: randomUUID(),
    deviceSeq: seq,
    payload: {
      sessionId: opts.sessionId ?? sessionId,
      cashierId,
      memberId: opts.memberId ?? null,
      soldAt: new Date().toISOString(),
      provisionalNumber: `CAISSE1-${seq}`,
      lines: lines.map((l) => ({
        productId: l.productId,
        label: 'Article',
        qty: l.qty ?? '1',
        unitPrice: l.unitPrice,
        catalogPrice: l.unitPrice,
        discount: l.discount ?? '0',
      })),
      payments: payments as never,
      total,
      emailReceipt: false,
      walletOverdraftForcedBy: opts.forcedBy ?? null,
    },
  };
}

beforeEach(async () => {
  await t.reset();
  await resetPos(t.db);
  const u = await createUser(t.db, { roles: ['CAISSE'] });
  cashierId = u.id;
  headers = await login(t.app, u.username!);
  const dev = await t.app.inject({
    method: 'POST',
    url: '/api/v1/pos/devices',
    headers,
    payload: { name: 'CAISSE1' },
  });
  deviceId = dev.json().id;
  sessionId = randomUUID();
  seq = 1;
  const [r] = await push([
    {
      kind: 'SESSION_OPEN',
      id: sessionId,
      deviceSeq: 1,
      payload: {
        sessionId,
        openedBy: cashierId,
        openedAt: new Date().toISOString(),
        openingFloat: '100.00',
      },
    },
  ]);
  expect(r!.status).toBe('OK');
});

describe('sales (R-VTE-10, R-SYNC-02)', () => {
  it('records a sale atomically: number, lines, payments, stock and cagnotte', async () => {
    const chips = await addProduct();
    const { household: h, members } = await addHousehold(1, '20.00');
    const op = saleOp(
      [{ productId: chips.id, qty: '2', unitPrice: '2.50' }],
      [
        { method: 'WALLET', amount: '3.00' },
        { method: 'CASH', amount: '2.00', tendered: '5.00', change: '3.00' },
      ],
      { memberId: members[0]!.id },
    );
    const [r] = await push([op]);
    expect(r).toMatchObject({
      status: 'OK',
      number: `T-${new Date().getFullYear()}-000001`,
      warnings: [],
    });

    const [s] = await t.db.select().from(sale).where(eq(sale.id, op.id));
    expect(s).toMatchObject({
      total: '5.00',
      householdId: h.id,
      provisionalNumber: op.kind === 'SALE' ? op.payload.provisionalNumber : '',
    });
    expect((await t.db.select().from(product).where(eq(product.id, chips.id)))[0]!.stockQty).toBe(
      '8.000',
    );
    expect(await balance(h.id)).toBe('17.00');
  });

  it('replaying an operation returns the same result without effect', async () => {
    const chips = await addProduct();
    const op = saleOp(
      [{ productId: chips.id, unitPrice: '2.50' }],
      [{ method: 'CASH', amount: '2.50' }],
    );
    const [a] = await push([op]);
    const [b] = await push([op]);
    expect(b).toEqual(a);
    expect(await t.db.select().from(sale)).toHaveLength(1);
    expect(await t.db.select().from(stockMovement)).toHaveLength(1);
  });

  it('CA §4.4: 50 offline tickets pushed twice are recorded once, stock and cagnotte up to date', async () => {
    const chips = await addProduct({ stockQty: '100' });
    const { household: h, members } = await addHousehold(1, '100.00');
    const ops = Array.from({ length: 50 }, () =>
      saleOp(
        [{ productId: chips.id, unitPrice: '2.50' }],
        [
          { method: 'WALLET', amount: '1.00' },
          { method: 'CASH', amount: '1.50' },
        ],
        { memberId: members[0]!.id },
      ),
    );
    const first = await push(ops);
    expect(first.every((r) => r.status === 'OK')).toBe(true);
    await push(ops);
    expect((await t.db.select({ n: sql<number>`count(*)::int` }).from(sale))[0]!.n).toBe(50);
    expect((await t.db.select().from(product).where(eq(product.id, chips.id)))[0]!.stockQty).toBe(
      '50.000',
    );
    expect(await balance(h.id)).toBe('50.00');
    // Numbers are continuous (§5.7).
    expect(new Set(first.map((r) => r.number)).size).toBe(50);
  });

  it('CA §4.3: two members of a household pay 10 € each by cagnotte → −20 €, two PURCHASE entries', async () => {
    const p = await addProduct({ salePrice: '10.00' });
    const { household: h, members } = await addHousehold(2, '50.00');
    await push([
      saleOp([{ productId: p.id, unitPrice: '10.00' }], [{ method: 'WALLET', amount: '10.00' }], {
        memberId: members[0]!.id,
      }),
      saleOp([{ productId: p.id, unitPrice: '10.00' }], [{ method: 'WALLET', amount: '10.00' }], {
        memberId: members[1]!.id,
      }),
    ]);
    expect(await balance(h.id)).toBe('30.00');
    const entries = await t.db
      .select()
      .from(walletEntry)
      .where(and(eq(walletEntry.householdId, h.id), eq(walletEntry.kind, 'PURCHASE')));
    expect(entries).toHaveLength(2);
  });

  it('R-SYNC-04: accepts an offline overdraft, a changed price and an inactive product with warnings', async () => {
    const p = await addProduct({ salePrice: '3.00', status: 'INACTIVE' });
    const { household: h, members } = await addHousehold(1, '1.00');
    const [r] = await push([
      saleOp([{ productId: p.id, unitPrice: '2.50' }], [{ method: 'WALLET', amount: '2.50' }], {
        memberId: members[0]!.id,
      }),
    ]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code).sort()).toEqual([
      'PRICE_CHANGED',
      'PRODUCT_INACTIVE',
      'WALLET_OVERDRAFT',
    ]);
    expect(await balance(h.id)).toBe('-1.50');
  });

  it('rejects an incoherent ticket and keeps the rejection on replay', async () => {
    const p = await addProduct();
    const op = saleOp(
      [{ productId: p.id, unitPrice: '2.50' }],
      [{ method: 'CASH', amount: '2.00' }],
      { total: '2.00' },
    );
    const [r] = await push([op]);
    expect(r).toMatchObject({
      status: 'REJECTED',
      error: 'Total du ticket incohérent avec ses lignes.',
    });
    expect(await t.db.select().from(sale)).toHaveLength(0);
    expect((await push([op]))[0]).toEqual(r);
  });

  it('rejects a cagnotte payment without a member, and the following ops still go through (R-SYNC-03)', async () => {
    const p = await addProduct();
    const [bad, good] = await push([
      saleOp([{ productId: p.id, unitPrice: '2.50' }], [{ method: 'WALLET', amount: '2.50' }]),
      saleOp([{ productId: p.id, unitPrice: '2.50' }], [{ method: 'CASH', amount: '2.50' }]),
    ]);
    expect(bad!.status).toBe('REJECTED');
    expect(good!.status).toBe('OK');
  });

  it('R-ADH-05: a membership line creates the membership, a renewal starts after the current one', async () => {
    const [annual] = await t.db
      .select()
      .from(membershipType)
      .where(eq(membershipType.code, 'ANNUAL'));
    const { household: h, members } = await addHousehold(1);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date());
    await push([
      saleOp(
        [{ productId: annual!.productId!, unitPrice: '12.00' }],
        [{ method: 'CASH', amount: '12.00' }],
        { memberId: members[0]!.id },
      ),
    ]);
    await push([
      saleOp(
        [{ productId: annual!.productId!, unitPrice: '12.00' }],
        [{ method: 'CARD', amount: '12.00' }],
        { memberId: members[0]!.id },
      ),
    ]);
    const ms = await t.db
      .select()
      .from(membership)
      .where(eq(membership.householdId, h.id))
      .orderBy(membership.startDate);
    expect(ms).toHaveLength(2);
    expect(ms[0]!.startDate).toBe(today);
    expect(ms[1]!.startDate > ms[0]!.endDate).toBe(true);
    // Services do not move the stock.
    expect(await t.db.select().from(stockMovement)).toHaveLength(0);
  });

  it('R-CAG-05: the change can be paid into the cagnotte', async () => {
    const p = await addProduct({ salePrice: '17.50' });
    const { household: h, members } = await addHousehold(1);
    await push([
      saleOp(
        [{ productId: p.id, unitPrice: '17.50' }],
        [
          {
            method: 'CASH',
            amount: '17.50',
            tendered: '20.00',
            change: '2.50',
            changeToWallet: true,
          },
        ],
        { memberId: members[0]!.id },
      ),
    ]);
    expect(await balance(h.id)).toBe('2.50');
  });
});

describe('cancellation (R-VTE-12)', () => {
  it('reverses stock, cagnotte and membership, once', async () => {
    const chips = await addProduct();
    const [annual] = await t.db
      .select()
      .from(membershipType)
      .where(eq(membershipType.code, 'ANNUAL'));
    const { household: h, members } = await addHousehold(1, '20.00');
    const op = saleOp(
      [
        { productId: chips.id, unitPrice: '2.50' },
        { productId: annual!.productId!, unitPrice: '12.00' },
      ],
      [{ method: 'WALLET', amount: '14.50' }],
      { memberId: members[0]!.id },
    );
    await push([op]);
    const cancel = (id = randomUUID()): SyncOp => ({
      kind: 'SALE_CANCEL',
      id,
      deviceSeq: ++seq,
      payload: {
        cancelSaleId: randomUUID(),
        saleId: op.id,
        sessionId,
        cashierId,
        at: new Date().toISOString(),
        provisionalNumber: 'X',
        reason: 'erreur',
      },
    });
    const [r] = await push([cancel()]);
    expect(r!.status).toBe('OK');
    expect(await balance(h.id)).toBe('20.00');
    expect((await t.db.select().from(product).where(eq(product.id, chips.id)))[0]!.stockQty).toBe(
      '10.000',
    );
    expect(
      (await t.db.select().from(membership).where(eq(membership.householdId, h.id)))[0]!
        .cancelledAt,
    ).not.toBeNull();
    expect((await t.db.select().from(sale).where(eq(sale.id, op.id)))[0]!.status).toBe('CANCELLED');
    expect((await push([cancel()]))[0]).toMatchObject({
      status: 'REJECTED',
      error: 'Ce ticket est déjà annulé.',
    });
  });
});

describe('closing (R-SES-02, R-SES-03)', () => {
  it('CA §4.5: 100 float, 50 cash sales, 12 membership in cash, 20 top-up by cheque → 162 expected', async () => {
    const p = await addProduct({ salePrice: '50.00' });
    const { household: h } = await addHousehold(1);
    await push([
      saleOp([{ productId: p.id, unitPrice: '50.00' }], [{ method: 'CASH', amount: '50.00' }]),
      {
        kind: 'WALLET_TOPUP',
        id: randomUUID(),
        deviceSeq: ++seq,
        payload: {
          sessionId,
          cashierId,
          householdId: h.id,
          amount: '20.00',
          method: 'CHEQUE',
          at: new Date().toISOString(),
          emailReceipt: false,
        },
      },
    ]);
    // A membership paid in cash outside a sale, recorded on the session (back-office style).
    await t.db
      .execute(sql`insert into app.member_payment (id, household_id, date, amount, purpose, method, cash_session_id)
      values (gen_random_uuid(), ${h.id}, current_date, 12, 'MEMBERSHIP', 'CASH', ${sessionId})`);

    const summary = (
      await t.app.inject({ url: `/api/v1/pos/sessions/${sessionId}/summary`, headers })
    ).json();
    expect(summary).toMatchObject({
      cashSales: '50.00',
      cashOther: '12.00',
      chequesComputed: '20.00',
      salesCount: 1,
    });

    const close = () =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/pos/sessions/${sessionId}/close`,
        headers,
        payload: {
          denominations: { '5000': 3, '200': 6 },
          bankDeposit: '60',
          chequesCount: 1,
          chequesTotal: '20',
          cardTotalDeclared: '0',
        },
      });
    const res = await close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      expectedCash: '162.00',
      countedCash: '162.00',
      difference: '0.00',
      nextFloat: '102.00',
    });
    expect((await close()).statusCode).toBe(409);

    // The next session proposes the new float (R-SES-01).
    const state = (
      await t.app.inject({ url: `/api/v1/pos/devices/${deviceId}/state`, headers })
    ).json();
    expect(state).toMatchObject({ openSession: null, proposedFloat: '102.00' });

    // Reopening is for ADMIN only.
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/pos/sessions/${sessionId}/reopen`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('snapshot (R-OFF-02, R-SYNC-06)', () => {
  it('replicates products, members and balances without personal details', async () => {
    const p = await addProduct({}, '3168930167983');
    const { household: h, members } = await addHousehold(1, '7.00');
    await t.db
      .update(member)
      .set({ street: '1 rue Haute', qrTokenHash: 'abc' })
      .where(eq(member.id, members[0]!.id));
    // The cursor overlaps the last second on purpose; let the setup rows fall before it.
    await new Promise((r) => setTimeout(r, 1100));
    const snap = (await t.app.inject({ url: '/api/v1/sync/snapshot', headers })).json();
    expect(snap.full).toBe(true);
    expect(snap.products.find((x: { id: string }) => x.id === p.id)).toMatchObject({
      eans: ['3168930167983'],
      salePrice: '2.50',
    });
    const m = snap.members.find((x: { id: string }) => x.id === members[0]!.id);
    expect(m).toMatchObject({ qrTokenHash: 'abc', hasEmail: true, isCashier: false });
    expect(m).not.toHaveProperty('street');
    expect(m).not.toHaveProperty('email');
    expect(snap.members.find((x: { id: string }) => x.id === cashierId).isCashier).toBe(true);
    expect(snap.households.find((x: { id: string }) => x.id === h.id)).toMatchObject({
      balance: '7.00',
    });
    expect(snap.settings).toMatchObject({ overdraftLimit: '0.00', sellToNonMembers: true });

    const inc = (
      await t.app.inject({
        url: `/api/v1/sync/snapshot?since=${encodeURIComponent(snap.cursor)}`,
        headers,
      })
    ).json();
    expect(inc.full).toBe(false);
    expect(inc.products).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1100));
    await t.db.update(product).set({ salePrice: '2.60' }).where(eq(product.id, p.id));
    const inc2 = (
      await t.app.inject({
        url: `/api/v1/sync/snapshot?since=${encodeURIComponent(snap.cursor)}`,
        headers,
      })
    ).json();
    expect(inc2.products.map((x: { id: string }) => x.id)).toEqual([p.id]);
  });

  it('is reserved to the CAISSE role', async () => {
    const u = await createUser(t.db, { roles: ['COMPTA'] });
    const h = await login(t.app, u.username!);
    expect((await t.app.inject({ url: '/api/v1/sync/snapshot', headers: h })).statusCode).toBe(403);
  });
});

describe('pre-orders (R-PRE-01..03)', () => {
  const tomorrow = () => {
    const d = new Date(Date.now() + 86_400_000);
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(d);
  };

  it('a member orders, the shop sees it, the till collects it, the suggestion counts it', async () => {
    const jam = await addProduct({
      name: 'Confiture',
      salePrice: '4.00',
      saleCondition: 'ON_ORDER',
    });
    const shelf = await addProduct({ name: 'Chips', saleCondition: 'ON_SITE' });
    const customer = await createUser(t.db, { roles: [] });
    const ch = await login(t.app, customer.username!);
    const call = (method: 'GET' | 'POST', url: string, h: Headers, payload?: object) =>
      t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });

    // Only products sold on order are in the shop window.
    const shop = (await call('GET', '/shop/products', ch)).json() as { id: string }[];
    expect(shop.map((p) => p.id)).toContain(jam.id);
    expect(shop.map((p) => p.id)).not.toContain(shelf.id);

    // R-PRE-01: a product not sold on order, or a past date, is refused.
    const body = { pickupDate: tomorrow(), lines: [{ productId: jam.id, qty: '2' }] };
    expect(
      (
        await call('POST', '/preorders', ch, {
          ...body,
          lines: [{ productId: shelf.id, qty: '1' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/preorders', ch, { ...body, pickupDate: '2020-01-01' })).statusCode,
    ).toBe(400);
    const created = await call('POST', '/preorders', ch, body);
    expect(created.statusCode).toBe(200);
    const { id, number } = created.json();
    expect(number).toMatch(/^PC-\d{4}-0001$/);

    // The member sees their order only; another member does not.
    const mine = (await call('GET', '/preorders/mine', ch)).json();
    expect(mine).toHaveLength(1);
    expect(mine[0].totalCents).toBe(800);
    const stranger = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    expect((await call('GET', `/preorders/${id}`, stranger)).statusCode).toBe(404);
    expect((await call('GET', '/preorders', ch)).statusCode).toBe(403);

    // R-PRE-02: the quantity is added to the supplier suggestion, even with no minimum stock.
    const { reservedByProduct } = await import('../src/modules/preorders/routes');
    expect((await reservedByProduct(t.db, [jam.id])).get(jam.id)).toBe(2000);

    // The till lists it and collects it: the ticket closes the order (R-PRE-03).
    const open = (await call('GET', '/preorders?open=true', headers)).json();
    expect(open.map((o: { id: string }) => o.id)).toContain(id);
    const op = saleOp(
      [{ productId: jam.id, qty: '2', unitPrice: '4.00' }],
      [{ method: 'CASH', amount: '8.00' }],
    );
    (op as { payload: { preorderId?: string } }).payload.preorderId = id;
    expect((await push([op]))[0]!.status).toBe('OK');
    const after = (await call('GET', `/preorders/${id}`, ch)).json();
    expect(after.status).toBe('PICKED_UP');
    expect(after.saleId).toBeTruthy();
    expect((await reservedByProduct(t.db, [jam.id])).size).toBe(0);
    // A collected order cannot be cancelled.
    expect(
      (await call('POST', `/preorders/${id}/status`, ch, { status: 'CANCELLED' })).statusCode,
    ).toBe(403);
  });

  it('a member may cancel their own order while it is only received', async () => {
    const jam = await addProduct({ saleCondition: 'BOTH' });
    const customer = await createUser(t.db, { roles: [] });
    const ch = await login(t.app, customer.username!);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/preorders',
      headers: ch,
      payload: { pickupDate: tomorrow(), lines: [{ productId: jam.id, qty: '1' }] },
    });
    const { id } = res.json();
    const cancel = await t.app.inject({
      method: 'POST',
      url: `/api/v1/preorders/${id}/status`,
      headers: ch,
      payload: { status: 'CANCELLED' },
    });
    expect(cancel.statusCode).toBe(200);
  });
});
