import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  household,
  householdBalance,
  member,
  product,
  stockMovement,
  walletEntry,
  type Db,
} from '@episoft/db';
import type { SyncOp } from '@episoft/shared';
import { expectIntegrity } from './integrity-helper';
import { createUser, login, setupTestApp } from './helpers';

// Properties of the synchronisation: whatever a till sends (a random run of tickets,
// cancellations and top-ups), sending it twice, in pieces, or out of order gives the same books,
// and the books balance: stock, cagnotte, cash drawer. Reproducible: the seed is the test name.

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

/** Small seeded generator (mulberry32): the same seed always draws the same ops. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  deviceId: string;
  sessionId: string;
  cashierId: string;
  memberId: string;
  householdId: string;
  productIds: string[];
  headers: Record<string, string>;
}

const START_STOCK = 1000;
const START_WALLET_CENTS = 10_000;

async function newWorld(db: Db, app: typeof t.app): Promise<World> {
  await t.reset();
  await db.execute(sql`truncate app.preorder_line, app.preorder, app.sync_receipt, app.sale_payment,
    app.sale_line, app.membership, app.wallet_entry, app.member_payment, app.sale, app.cash_count,
    app.cash_session, app.pos_device, app.stock_movement, app.product_barcode, app.number_counter,
    app.sync_rejection cascade`);
  await db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
  const cashier = await createUser(db, { roles: ['CAISSE'] });
  const headers = await login(app, cashier.username!);
  const deviceId = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/pos/devices',
      headers,
      payload: { name: 'PROP1' },
    })
  ).json().id as string;
  const [h] = await db.insert(household).values({}).returning();
  const [m] = await db
    .insert(member)
    .values({ firstName: 'Prop', lastName: 'ERTY', householdId: h!.id, status: 'ACTIVE' })
    .returning();
  await db.insert(walletEntry).values({
    householdId: h!.id,
    amount: (START_WALLET_CENTS / 100).toFixed(2),
    kind: 'CORRECTION',
  });
  const productIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [p] = await db
      .insert(product)
      .values({
        code: `99000${i}`,
        name: `Produit ${i}`,
        salePrice: ['1.50', '2.75', '10.00'][i]!,
        stockQty: String(START_STOCK),
      })
      .returning();
    await db
      .insert(stockMovement)
      .values({ productId: p!.id, qty: String(START_STOCK), kind: 'INITIAL' });
    productIds.push(p!.id);
  }
  return {
    deviceId,
    sessionId: randomUUID(),
    cashierId: cashier.id,
    memberId: m!.id,
    householdId: h!.id,
    productIds,
    headers,
  };
}

interface Plan {
  ops: SyncOp[];
  /** What the books must say once everything is recorded. */
  stock: number[];
  walletCents: number;
  cashCents: number;
}

/** A random run: tickets (cash, or part from the cagnotte), some cancelled, some top-ups. */
function plan(w: World, seed: number, count: number): Plan {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const prices = [150, 275, 1000];
  const ops: SyncOp[] = [
    {
      kind: 'SESSION_OPEN',
      id: w.sessionId,
      deviceSeq: 1,
      payload: {
        sessionId: w.sessionId,
        openedBy: w.cashierId,
        openedAt: new Date().toISOString(),
        openingFloat: '100.00',
      },
    },
  ];
  const stock = [START_STOCK, START_STOCK, START_STOCK];
  let wallet = START_WALLET_CENTS;
  let cash = 10_000;
  const sales: {
    id: string;
    seq: number;
    lines: { p: number; qty: number }[];
    walletCents: number;
    cashCents: number;
  }[] = [];
  let seq = 1;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    seq++;
    const kind = r();
    if (kind < 0.12) {
      const cents = (1 + Math.floor(r() * 40)) * 100;
      ops.push({
        kind: 'WALLET_TOPUP',
        id: randomUUID(),
        deviceSeq: seq,
        payload: {
          sessionId: w.sessionId,
          cashierId: w.cashierId,
          householdId: w.householdId,
          amount: (cents / 100).toFixed(2),
          method: 'CASH',
          at: new Date(now + seq).toISOString(),
          emailReceipt: false,
        },
      });
      wallet += cents;
      cash += cents;
    } else if (kind < 0.27 && sales.some((s) => !('cancelled' in s))) {
      const open = sales.filter((s) => !('cancelled' in s));
      const s = pick(open) as (typeof sales)[number] & { cancelled?: true };
      s.cancelled = true;
      ops.push({
        kind: 'SALE_CANCEL',
        id: randomUUID(),
        deviceSeq: seq,
        payload: {
          cancelSaleId: randomUUID(),
          saleId: s.id,
          sessionId: w.sessionId,
          cashierId: w.cashierId,
          at: new Date(now + seq).toISOString(),
          provisionalNumber: `PROP1-${seq}`,
        },
      });
      for (const l of s.lines) stock[l.p]! += l.qty;
      wallet += s.walletCents;
      cash -= s.cashCents;
    } else {
      const nLines = 1 + Math.floor(r() * 3);
      const lines = Array.from({ length: nLines }, () => ({
        p: Math.floor(r() * 3),
        qty: 1 + Math.floor(r() * 5),
      }));
      const total = lines.reduce((s, l) => s + l.qty * prices[l.p]!, 0);
      const walletCents = r() < 0.4 ? Math.floor(r() * (total + 1)) : 0;
      const cashCents = total - walletCents;
      const id = randomUUID();
      const payments = [
        ...(walletCents > 0 ? [{ method: 'WALLET', amount: (walletCents / 100).toFixed(2) }] : []),
        ...(cashCents > 0 ? [{ method: 'CASH', amount: (cashCents / 100).toFixed(2) }] : []),
      ];
      ops.push({
        kind: 'SALE',
        id,
        deviceSeq: seq,
        payload: {
          sessionId: w.sessionId,
          cashierId: w.cashierId,
          memberId: walletCents > 0 || r() < 0.5 ? w.memberId : null,
          soldAt: new Date(now + seq).toISOString(),
          provisionalNumber: `PROP1-${seq}`,
          lines: lines.map((l) => ({
            productId: w.productIds[l.p]!,
            label: `Produit ${l.p}`,
            qty: String(l.qty),
            unitPrice: (prices[l.p]! / 100).toFixed(2),
            catalogPrice: (prices[l.p]! / 100).toFixed(2),
            discount: '0',
          })),
          payments: payments as never,
          total: (total / 100).toFixed(2),
          emailReceipt: false,
          walletOverdraftForcedBy: null,
        },
      });
      for (const l of lines) stock[l.p]! -= l.qty;
      wallet -= walletCents;
      cash += cashCents;
      sales.push({ id, seq, lines, walletCents, cashCents });
    }
  }
  return { ops, stock, walletCents: wallet, cashCents: cash };
}

/** One request. `allowRetry`: a cancellation ahead of its ticket is answered 409 (« not yet »). */
async function send(w: World, ops: SyncOp[]) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: w.headers,
    payload: { deviceId: w.deviceId, ops },
  });
}

async function push(w: World, ops: SyncOp[]) {
  const res = await send(w, ops);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results as { status: string; error?: string }[];
}

/** Everything the books say, for comparing two ways of sending the same tickets. */
async function books(w: World) {
  const stock = await Promise.all(
    w.productIds.map(async (id) =>
      Number((await t.db.select().from(product).where(eq(product.id, id)))[0]!.stockQty),
    ),
  );
  const [bal] = await t.db
    .select()
    .from(householdBalance)
    .where(eq(householdBalance.householdId, w.householdId));
  const summary = (
    await t.app.inject({ url: `/api/v1/pos/sessions/${w.sessionId}/summary`, headers: w.headers })
  ).json();
  const counts = (
    await t.db.execute(sql`select
      (select count(*)::int from app.sale) as sales,
      (select count(*)::int from app.sale where cancels_sale_id is not null) as cancellations,
      (select coalesce(sum(total), 0)::text from app.sale) as total,
      (select count(*)::int from app.wallet_entry) as wallet_entries,
      (select count(*)::int from app.stock_movement) as movements,
      (select count(*)::int from app.member_payment) as payments`)
  ).rows[0];
  return {
    stock,
    walletCents: Math.round(Number(bal?.balance ?? 0) * 100),
    cashCents: Math.round((Number(summary.cashSales) + Number(summary.cashOther)) * 100) + 10_000,
    counts,
  };
}

const SEEDS = [1, 2, 3, 4, 5, 6];

describe.each(SEEDS)('a random run of tickets, cancellations and top-ups (seed %i)', (seed) => {
  it('is recorded as planned, and the books balance', async () => {
    const w = await newWorld(t.db, t.app);
    const p = plan(w, seed, 30);
    const results = await push(w, p.ops);
    expect(
      results.every((x) => x.status === 'OK'),
      JSON.stringify(results.filter((x) => x.status !== 'OK')),
    ).toBe(true);
    const b = await books(w);
    expect(b.stock).toEqual(p.stock);
    expect(b.walletCents).toBe(p.walletCents);
    expect(b.cashCents).toBe(p.cashCents);
    await expectIntegrity(t.db);
  });

  it('gives the same books when the same tickets are sent again', async () => {
    const w = await newWorld(t.db, t.app);
    const p = plan(w, seed, 30);
    await push(w, p.ops);
    const once = await books(w);
    const again = await push(w, p.ops);
    expect(again.every((x) => x.status === 'OK')).toBe(true);
    expect(await books(w)).toEqual(once);
  });

  it('gives the same books when they are sent in pieces, out of order, with repeats', async () => {
    const w = await newWorld(t.db, t.app);
    const p = plan(w, seed, 30);
    await push(w, p.ops);
    const reference = await books(w);

    const w2 = await newWorld(t.db, t.app);
    const p2 = plan(w2, seed, 30);
    const r = rng(seed * 7919);
    const shuffled = [...p2.ops].sort(() => r() - 0.5);
    const third = Math.ceil(shuffled.length / 3);
    // The server orders each request by device sequence. A cancellation that arrives before its
    // ticket is answered « not yet » (409), nothing is stored, and it goes through when the whole
    // run is sent again in order: no cancellation is ever lost.
    for (const piece of [
      shuffled.slice(0, third),
      shuffled.slice(third, 2 * third),
      shuffled.slice(2 * third),
    ]) {
      const res = await send(w2, piece);
      expect([200, 409]).toContain(res.statusCode); // 409: a cancellation ahead of its ticket
    }
    await push(w2, [...p2.ops]);
    const pieces = await books(w2);
    expect(pieces.stock).toEqual(reference.stock);
    expect(pieces.walletCents).toBe(reference.walletCents);
    expect(pieces.cashCents).toBe(reference.cashCents);
    await expectIntegrity(t.db);
  });
});
