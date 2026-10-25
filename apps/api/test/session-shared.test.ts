import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionPresence, SyncOp } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// R-SES-05 and R-SES-06: one session for the whole shop, joined by every till; the closing says
// who else is there.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
let till: Till;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});

const get = (url: string, h: Headers = till.admin) =>
  t.app.inject({ url: `/api/v1${url}`, headers: h });

/** A second till: another device, which opens its own session (offline, say). */
async function secondTill() {
  const cashier = await createUser(t.db, { roles: ['CAISSE'] });
  const headers = await login(t.app, cashier.username!);
  const device = (
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/pos/devices',
      headers,
      payload: { name: 'CAISSE2' },
    })
  ).json().id as string;
  const sessionId = randomUUID();
  let seq = 0;
  const push = async (ops: SyncOp[]) =>
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers,
        payload: { deviceId: device, ops },
      })
    ).json().results as { status: string; sessionId?: string; warnings: { code: string }[] }[];
  const open = (float = '999.00'): SyncOp => ({
    kind: 'SESSION_OPEN',
    id: sessionId,
    deviceSeq: ++seq,
    payload: {
      sessionId,
      openedBy: cashier.id,
      openedAt: new Date().toISOString(),
      openingFloat: float,
    },
  });
  const sale = (productId: string, soldAt = new Date()): SyncOp => ({
    kind: 'SALE',
    id: randomUUID(),
    deviceSeq: ++seq,
    payload: {
      sessionId,
      cashierId: cashier.id,
      memberId: null,
      soldAt: soldAt.toISOString(),
      provisionalNumber: `CAISSE2-${seq}`,
      lines: [
        {
          productId,
          label: 'Article',
          qty: '1',
          unitPrice: '2.50',
          catalogPrice: '2.50',
          discount: '0',
        },
      ],
      payments: [{ method: 'CASH', amount: '2.50' }] as never,
      total: '2.50',
      emailReceipt: false,
      walletOverdraftForcedBy: null,
    },
  });
  return { cashier, headers, device, sessionId, push, open, sale };
}

describe('a single open session for the shop (R-SES-05)', () => {
  it('the database refuses a second open session', async () => {
    await expect(
      t.db.execute(
        sql`insert into app.cash_session (id, device_id, opened_at, opening_float)
            values (gen_random_uuid(), ${till.deviceId}, now(), 10)`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('a second till that opens its own session is attached to the open one', async () => {
    const b = await secondTill();
    const [r] = await b.push([b.open()]);
    expect(r).toMatchObject({ status: 'OK', sessionId: till.sessionId });
    const open = await t.db.execute<{ id: string; opening_float: string }>(
      sql`select id, opening_float::text from app.cash_session where status = 'OPEN'`,
    );
    // The float of the second till is ignored: one drawer.
    expect(open.rows).toEqual([{ id: till.sessionId, opening_float: '100.00' }]);
    expect(
      (await get('/audit?limit=20')).json().map((e: { action: string }) => e.action),
    ).toContain('session.join');
  });

  it('opening twice is the same answer, and the first till keeps its own id', async () => {
    const b = await secondTill();
    await b.push([b.open()]);
    // Replayed by the till (receipt) and re-sent as a new operation: still attached.
    const again = { ...b.open(), id: randomUUID() };
    const [r] = await b.push([again]);
    expect(r).toMatchObject({ status: 'OK', sessionId: till.sessionId });
    const [own] = await till.push([
      { ...till.saleOp([{ productId: (await addProduct(t.db)).id, unitPrice: '2.50' }], '2.50') },
    ]);
    expect(own).toMatchObject({ status: 'OK' });
  });

  it('a ticket sold under the id the second till generated lands in the open session', async () => {
    const p = await addProduct(t.db, { stockQty: '20' });
    const b = await secondTill();
    // The second till sold offline before its session was known to the server.
    const results = await b.push([b.open(), b.sale(p.id)]);
    expect(results.map((r) => r.status)).toEqual(['OK', 'OK']);
    const sales = await t.db.execute<{ session_id: string }>(
      sql`select session_id from app.sale where provisional_number like 'CAISSE2-%'`,
    );
    expect(sales.rows).toEqual([{ session_id: till.sessionId }]);
    // And the closing of the open session counts its cash.
    const summary = (await get(`/pos/sessions/${b.sessionId}/summary`)).json();
    expect(summary.cashSales).toBe('2.50');
  });

  it('the routes accept the alias of a session as its id', async () => {
    const b = await secondTill();
    await b.push([b.open()]);
    const direct = await get(`/pos/sessions/${till.sessionId}/summary`);
    const viaAlias = await get(`/pos/sessions/${b.sessionId}/summary`);
    expect(viaAlias.statusCode).toBe(200);
    expect(viaAlias.json()).toEqual(direct.json());
  });

  it('the device state gives the open session of the shop, whichever till asks', async () => {
    const b = await secondTill();
    const state = (
      await t.app.inject({
        url: `/api/v1/pos/devices/${b.device}/state`,
        headers: b.headers,
      })
    ).json();
    expect(state.openSession).toMatchObject({ id: till.sessionId });
  });

  it('a ticket sold on a later day than the session is kept and flagged', async () => {
    const p = await addProduct(t.db, { stockQty: '20' });
    await t.db.execute(
      sql`update app.cash_session set opened_at = now() - interval '2 days' where id = ${till.sessionId}`,
    );
    const [r] = await till.push([till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('SESSION_PREVIOUS_DAY');
  });

  it('a ticket sold the evening before, received the next morning, is not flagged', async () => {
    const p = await addProduct(t.db, { stockQty: '20' });
    const yesterday = new Date(Date.now() - 86_400_000);
    await t.db.execute(
      sql`update app.cash_session set opened_at = ${yesterday.toISOString()} where id = ${till.sessionId}`,
    );
    const [r] = await till.push([
      till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50', yesterday),
    ]);
    expect(r!.warnings.map((w) => w.code)).not.toContain('SESSION_PREVIOUS_DAY');
  });
});

describe('who else is there when the till is closed (R-SES-06)', () => {
  it('lists the cashiers who sold and the tills that took part', async () => {
    const p = await addProduct(t.db, { stockQty: '20' });
    const b = await secondTill();
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    await b.push([b.open(), b.sale(p.id)]);
    const presence = (
      await get(`/pos/sessions/${till.sessionId}/presence`)
    ).json() as SessionPresence;
    expect(presence.cashiers.map((c) => c.id).sort()).toEqual(
      [till.cashierId, b.cashier.id].sort(),
    );
    // A till is named by the person who last sold on it.
    expect(presence.devices.map((d) => d.label).sort()).toEqual(
      [till.cashierName, `${b.cashier.firstName} ${b.cashier.lastName}`].sort(),
    );
    expect(presence.devices.every((d) => d.lastSyncAt)).toBe(true);
    // Reachable through the alias too.
    expect((await get(`/pos/sessions/${b.sessionId}/presence`)).statusCode).toBe(200);
  });

  it('lists a till that sold in the session even when it has not contacted the server lately', async () => {
    const p = await addProduct(t.db, { stockQty: '20' });
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    await t.db.execute(sql`update app.pos_device set last_sync_at = now() - interval '3 days'`);
    const presence = (
      await get(`/pos/sessions/${till.sessionId}/presence`)
    ).json() as SessionPresence;
    expect(presence.devices).toEqual([
      expect.objectContaining({ id: till.deviceId, label: till.cashierName }),
    ]);
  });

  it('is reserved to the cash staff', async () => {
    const stranger = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    expect((await get(`/pos/sessions/${till.sessionId}/presence`, stranger)).statusCode).toBe(403);
  });
});

describe('merging sessions already open (migration 0025)', () => {
  it('moves the sales and payments of the extra sessions to the oldest open one', async () => {
    const p = await addProduct(t.db, { stockQty: '20' });
    // The state the old versions allowed: two tills, two open sessions. Rebuilt with the index
    // dropped, then merged by the migration's own statements.
    await t.db.execute(sql`drop index app.cash_session_one_open`);
    const b = await secondTill();
    const extra = b.sessionId;
    await t.db.execute(
      sql`insert into app.cash_session (id, device_id, opened_at, opening_float)
          values (${extra}, ${b.device}, now(), 50)`,
    );
    await b.push([b.sale(p.id)]);
    expect(
      (await t.db.execute(sql`select count(*)::int as n from app.sale where session_id = ${extra}`))
        .rows[0],
    ).toEqual({ n: 1 });

    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const migration = readFileSync(
      join(process.cwd(), '../../packages/db/drizzle/0025_one_open_session.sql'),
      'utf8',
    );
    const merge = /DO \$\$[\s\S]*?END \$\$;/.exec(migration)![0];
    await t.db.execute(sql.raw(merge));
    await t.db.execute(
      sql`create unique index cash_session_one_open on app.cash_session ((true)) where status = 'OPEN'`,
    );

    const open = await t.db.execute<{ id: string }>(
      sql`select id from app.cash_session where status = 'OPEN'`,
    );
    expect(open.rows).toEqual([{ id: till.sessionId }]);
    expect(
      (
        await t.db.execute(
          sql`select count(*)::int as n from app.sale where session_id = ${till.sessionId}`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
    expect(
      (
        await t.db.execute(
          sql`select session_id from app.cash_session_alias where alias_id = ${extra}`,
        )
      ).rows,
    ).toEqual([{ session_id: till.sessionId }]);
  });
});

describe('the cashiers connected to the till (R-SES-06)', () => {
  const connected = async (h: Headers = till.cashier) =>
    ((await get('/pos/connected', h)).json() as { id: string; name: string }[]).map((c) => c.name);

  it('lists the cashiers whose sign-in was used lately, never the others', async () => {
    const bruno = await createUser(t.db, { roles: ['CAISSE'] });
    const brunoHeaders = await login(t.app, bruno.username!);
    const customer = await createUser(t.db, { roles: [] });
    await login(t.app, customer.username!);
    const names = await connected();
    expect(names).toContain(till.cashierName);
    expect(names).toContain(`${bruno.firstName} ${bruno.lastName}`);
    expect(names).not.toContain(`${customer.firstName} ${customer.lastName}`);
    // The administrator of the fixture has no Caisse role: not listed either.
    expect(names).toHaveLength(2);
    expect(await connected(brunoHeaders)).toEqual(names);
  });

  it('forgets a cashier who has not been seen for a while, and one who signed out', async () => {
    const bruno = await createUser(t.db, { roles: ['CAISSE'] });
    const brunoHeaders = await login(t.app, bruno.username!);
    await t.db.execute(
      sql`update app.session set last_seen_at = now() - interval '2 hours' where member_id = ${bruno.id}`,
    );
    expect(await connected()).not.toContain(`${bruno.firstName} ${bruno.lastName}`);
    // Any request of his brings him back (the last contact is noted at most once a minute).
    await get('/me', brunoHeaders);
    expect(await connected()).toContain(`${bruno.firstName} ${bruno.lastName}`);
    await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: brunoHeaders });
    expect(await connected()).not.toContain(`${bruno.firstName} ${bruno.lastName}`);
  });

  it('is reserved to the cash staff', async () => {
    const stranger = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    expect((await get('/pos/connected', stranger)).statusCode).toBe(403);
  });
});

describe('the face values counted at closing', () => {
  it('accept the 200 and 100 euro notes, and count them', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/pos/sessions/${till.sessionId}/close`,
      headers: till.cashier,
      payload: {
        denominations: { '20000': 1, '10000': 2 },
        bankDeposit: '0',
        chequesCount: 0,
        chequesTotal: '0',
        cardTotalDeclared: '0',
        comment: 'comptage de test',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ countedCash: '400.00', expectedCash: '100.00' });
  });
});
