import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  cashSession,
  household,
  loginLog,
  member,
  sale,
  setting,
  userRole,
  walletEntry,
} from '@episoft/db';
import type { SyncOp } from '@episoft/shared';
import { resetPinFailures } from '../src/lib/till-cashier';
import { createUser, login, PASSWORD, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// R-SES-07: the cashier changes on the till without signing out. A (signed in) holds the session,
// B keeps the till. The journal names both; the session then reaches the till's routes only.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
let b: Awaited<ReturnType<typeof createUser>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
  b = await createUser(t.db, { roles: ['CAISSE'] });
  resetPinFailures();
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  h = till.cashier,
) => t.app.inject({ method, url: `/api/v1${url}`, headers: h, ...(payload ? { payload } : {}) });

const setPin = (pin = '4815', password = PASSWORD, id = b.id) =>
  call('PUT', `/pos/cashiers/${id}/pin`, { password, pin });

const requirePin = (on: boolean) =>
  t.db
    .insert(setting)
    .values({ key: 'pos.cashierSwitch', value: { requirePin: on } })
    .onConflictDoUpdate({ target: setting.key, set: { value: { requirePin: on } } });

/** A sale of 1 € in cash, kept by the given cashier. */
async function saleBy(cashierId: string, cashierCheck?: 'PIN' | 'DECLARED') {
  const p = await addProduct(t.db, { stockQty: '10' });
  const op = till.saleOp([{ productId: p.id, unitPrice: '1.00' }], '1.00');
  if (op.kind !== 'SALE') throw new Error('sale expected');
  const withCashier: SyncOp = { ...op, payload: { ...op.payload, cashierId, cashierCheck } };
  const [r] = await till.push([withCashier]);
  return { r: r!, saleId: op.id };
}

describe('the cashier code', () => {
  it('is chosen by the cashier with their own password, and checked like a sign-in', async () => {
    expect((await setPin('4815', 'mauvais mot de passe')).statusCode).toBe(401);
    const [failed] = await t.db
      .select()
      .from(loginLog)
      .where(and(eq(loginLog.memberId, b.id), eq(loginLog.success, false)));
    expect(failed).toBeDefined();
    expect((await setPin('1234')).statusCode).toBe(400);
    expect((await setPin()).statusCode).toBe(204);
    // Only a cashier has a code.
    const other = await createUser(t.db);
    expect((await setPin('4815', PASSWORD, other.id)).statusCode).toBe(403);
  });

  it('reaches the tills hashed, for the cashiers only, and is never shown nor exported', async () => {
    expect((await setPin()).statusCode).toBe(204);
    const snap = (await call('GET', '/sync/snapshot')).json();
    const mine = snap.members.find((m: { id: string }) => m.id === b.id);
    expect(mine.tillPin).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const plain = snap.members.find((m: { id: string; isCashier: boolean }) => !m.isCashier);
    expect(plain?.tillPin ?? null).toBeNull();
    expect(snap.settings.cashierPinRequired).toBe(true);

    const card = (await call('GET', `/members/${b.id}`, undefined, till.admin)).json();
    expect(card.hasTillPin).toBe(true);
    expect(JSON.stringify(card)).not.toMatch(/tillPassword/);
    const exported = await call('GET', `/members/${b.id}/export`, undefined, till.admin);
    expect(exported.body).not.toMatch(/tillPassword/);
    // The record of changes keeps that it changed, never the value.
    const { rows } = await t.db.execute<{ v: string }>(sql`
      select new ->> 'till_password_hash' as v from app.data_change
      where table_name = 'member' and new ? 'till_password_hash' order by id desc limit 1`);
    expect(rows[0]!.v).toBe('***');
  });

  it('is cleared by an administrator when forgotten', async () => {
    expect((await setPin()).statusCode).toBe(204);
    expect(
      (await call('DELETE', `/admin/users/${b.id}/till-pin`, undefined, till.admin)).statusCode,
    ).toBe(204);
    const [m] = await t.db.select().from(member).where(eq(member.id, b.id));
    expect(m!.tillPasswordHash).toBeNull();
  });
});

describe('a ticket kept by another cashier', () => {
  it('is in the name of the cashier, through the session of the person signed in', async () => {
    const { r, saleId } = await saleBy(b.id, 'PIN');
    expect(r.status).toBe('OK');
    const [s] = await t.db.select().from(sale).where(eq(sale.id, saleId));
    expect(s!.cashierId).toBe(b.id);
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.create'), eq(auditLog.entityId, saleId)));
    expect(entry).toMatchObject({ actorId: b.id, viaSessionOfId: till.cashierId });
    expect((entry!.after as { cashierCheck: string }).cashierCheck).toBe('PIN');
    // Searching the journal for the person signed in finds it too.
    const found = (
      await call('GET', `/audit?memberId=${till.cashierId}&limit=50`, undefined, till.admin)
    ).json() as { entityId: string; viaSessionOfName: string | null }[];
    expect(found.find((e) => e.entityId === saleId)?.viaSessionOfName).toBe(till.cashierName);
  });

  it('is flagged when the cashier was only declared and the association asks for the code', async () => {
    const { r } = await saleBy(b.id, 'DECLARED');
    expect(r.warnings.map((w) => w.code)).toContain('CASHIER_UNCHECKED');
    await requirePin(false);
    const { r: free } = await saleBy(b.id, 'DECLARED');
    expect(free.warnings.map((w) => w.code)).not.toContain('CASHIER_UNCHECKED');
  });

  it('is in the name of the person signed in, with no mark, when they keep the till', async () => {
    const { r, saleId } = await saleBy(till.cashierId);
    expect(r.warnings.map((w) => w.code)).not.toContain('CASHIER_UNCHECKED');
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.create'), eq(auditLog.entityId, saleId)));
    expect(entry).toMatchObject({ actorId: till.cashierId, viaSessionOfId: null });
  });

  it('never forces an overdraft with the rights of the person signed in', async () => {
    const [h] = await t.db.insert(household).values({}).returning();
    const [m] = await t.db
      .insert(member)
      .values({ firstName: 'Anne', lastName: 'FOYER', householdId: h!.id, status: 'ACTIVE' })
      .returning();
    const p = await addProduct(t.db, { stockQty: '10' });
    const op = till.saleOp([{ productId: p.id, unitPrice: '1.00' }], '1.00');
    if (op.kind !== 'SALE') throw new Error('sale expected');
    await till.push([
      {
        ...op,
        payload: {
          ...op.payload,
          cashierId: b.id,
          memberId: m!.id,
          payments: [{ method: 'WALLET', amount: '1.00' }],
          walletOverdraftForcedBy: till.cashierId,
        },
      },
    ]);
    const [w] = await t.db.select().from(walletEntry).where(eq(walletEntry.saleId, op.id));
    expect(w!.forcedBy).toBeNull();
  });
});

describe('the session while another cashier keeps the till', () => {
  const locked = async (path: string) => {
    const res = await t.app.inject({ url: path, headers: till.cashier });
    return { status: res.statusCode, code: res.statusCode === 403 ? res.json().code : null };
  };

  it('reaches the till only, from the first ticket of the other cashier', async () => {
    expect((await locked('/api/v1/me/household')).status).toBe(200);
    await saleBy(b.id, 'PIN');
    for (const path of ['/api/v1/me/household', '/%61pi/v1/me/household', '/api/v1/communes'])
      expect(await locked(path), path).toEqual({ status: 403, code: 'TILL_LOCKED' });
    expect((await locked('/api/v1/pos/connected')).status).toBe(200);
    expect((await call('GET', '/me')).json().tillCashierId).toBe(b.id);
  });

  it('gets the rest of the application back with the password of the person signed in', async () => {
    await saleBy(b.id, 'PIN');
    expect((await call('POST', '/auth/unlock', { password: 'pas le bon' })).statusCode).toBe(401);
    expect((await locked('/api/v1/me/household')).status).toBe(403);
    expect((await call('POST', '/auth/unlock', { password: PASSWORD })).statusCode).toBe(204);
    expect((await locked('/api/v1/me/household')).status).toBe(200);
    expect((await call('GET', '/me')).json().tillCashierId).toBeNull();
  });

  it('blocks the password after five wrong ones, like a sign-in', async () => {
    await saleBy(b.id, 'PIN');
    for (let i = 0; i < 5; i++) await call('POST', '/auth/unlock', { password: `faux ${i}` });
    expect((await call('POST', '/auth/unlock', { password: PASSWORD })).statusCode).toBe(429);
  });
});

describe('choosing the cashier at the till (online)', () => {
  it('checks the code at the server, blocks it after five wrong ones', async () => {
    expect((await setPin()).statusCode).toBe(204);
    for (let i = 0; i < 5; i++) {
      const res = await call('POST', '/pos/cashier', { cashierId: b.id, pin: '9999' });
      expect(res.json().code).toBe('PIN_WRONG');
    }
    const blocked = await call('POST', '/pos/cashier', { cashierId: b.id, pin: '4815' });
    expect(blocked.json().code).toBe('PIN_LOCKED');
    resetPinFailures();
    const ok = await call('POST', '/pos/cashier', { cashierId: b.id, pin: '4815' });
    expect(ok.json()).toEqual({ cashierId: b.id, check: 'PIN' });
    expect((await call('GET', '/me')).json().tillCashierId).toBe(b.id);
    // Back to oneself: only with the password.
    expect((await call('POST', '/pos/cashier', { cashierId: till.cashierId })).statusCode).toBe(
      409,
    );
  });

  it('accepts a cashier without a code yet as declared, and refuses someone not a cashier', async () => {
    expect((await call('POST', '/pos/cashier', { cashierId: b.id })).json().check).toBe('DECLARED');
    const other = await createUser(t.db);
    expect((await call('POST', '/pos/cashier', { cashierId: other.id })).statusCode).toBe(403);
  });

  it('restricts nothing when the person signed in chooses themself', async () => {
    const res = await call('POST', '/pos/cashier', { cashierId: till.cashierId });
    expect(res.json().check).toBe('SESSION');
    expect((await call('GET', '/me')).json().tillCashierId).toBeNull();
  });
});

describe('the closing by another cashier', () => {
  const close = (extra: object) =>
    call('POST', `/pos/sessions/${till.sessionId}/close`, {
      denominations: { '10000': 1 },
      bankDeposit: '0',
      chequesCount: 0,
      chequesTotal: '0',
      cardTotalDeclared: '0',
      comment: 'clôture de test',
      ...extra,
    });

  it('checks the code of the cashier who counted the drawer, and is in their name', async () => {
    expect((await setPin()).statusCode).toBe(204);
    expect((await close({ cashierId: b.id, pin: '0001' })).statusCode).toBe(403);
    const res = await close({ cashierId: b.id, pin: '4815' });
    expect(res.statusCode, res.body).toBe(200);
    const [s] = await t.db.select().from(cashSession).where(eq(cashSession.id, till.sessionId));
    expect(s!.closedBy).toBe(b.id);
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'session.close'))
      .orderBy(desc(auditLog.at));
    expect(entry).toMatchObject({ actorId: b.id, viaSessionOfId: till.cashierId });
    expect((entry!.after as { cashierCheck: string }).cashierCheck).toBe('PIN');
  });

  it('refuses a missing code when the cashier has one and the association asks for it', async () => {
    expect((await setPin()).statusCode).toBe(204);
    expect((await close({ cashierId: b.id })).statusCode).toBe(403);
  });
});

describe('an older ticket cancelled with the rights of another', () => {
  it('needs the administrator to keep the till themself', async () => {
    // The person signed in is an administrator; the ticket belongs to a closed session.
    await t.db.insert(userRole).values({ memberId: till.cashierId, roleCode: 'ADMIN' });
    const { saleId } = await saleBy(till.cashierId);
    const closed = await call('POST', `/pos/sessions/${till.sessionId}/force-close`, {
      comment: 'fin de journée',
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const next = randomUUID();
    await till.push([
      {
        kind: 'SESSION_OPEN',
        id: next,
        deviceSeq: till.nextSeq(),
        payload: {
          sessionId: next,
          openedBy: till.cashierId,
          openedAt: new Date().toISOString(),
          openingFloat: '100.00',
        },
      },
    ]);
    const cancel = (cashierId: string): SyncOp => ({
      kind: 'SALE_CANCEL',
      id: randomUUID(),
      deviceSeq: till.nextSeq(),
      payload: {
        cancelSaleId: randomUUID(),
        saleId,
        sessionId: next,
        cashierId,
        at: new Date().toISOString(),
        provisionalNumber: `CAISSE1-${randomUUID().slice(0, 4)}`,
      },
    });
    const [byOther] = await till.push([cancel(b.id)]);
    expect(byOther!.status).toBe('REJECTED');
    expect(byOther!.error).toMatch(/administrateur/);
    // The administrator takes the till back (password), then cancels it themself.
    expect((await call('POST', '/auth/unlock', { password: PASSWORD })).statusCode).toBe(204);
    const [bySelf] = await till.push([cancel(till.cashierId)]);
    expect(bySelf!.status).toBe('OK');
  });
});

describe('what a made-up cashier cannot do (review of the cashier switch)', () => {
  it('cannot put words in the mouth of someone who is not a cashier', async () => {
    const boss = await createUser(t.db, { roles: ['ADMIN'] });
    const { r, saleId } = await saleBy(boss.id, 'DECLARED');
    expect(r.warnings.map((w) => w.code)).toContain('CASHIER_ROLE');
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.create'), eq(auditLog.entityId, saleId)));
    // The journal keeps the person who sent it as author, not the administrator named.
    expect(entry).toMatchObject({ actorId: till.cashierId, viaSessionOfId: null });
  });

  it('does not restrict the session for an id that is not a cashier, and does not fail', async () => {
    const stranger = await createUser(t.db);
    const { r } = await saleBy(stranger.id, 'DECLARED');
    expect(r.status).toBe('OK');
    expect((await call('GET', '/me')).json().tillCashierId).toBeNull();
  });

  it("lets a colleague's guesses lock only their own attempts, not the cashier's own use", async () => {
    expect((await setPin()).statusCode).toBe(204);
    for (let i = 0; i < 6; i++)
      await call('POST', '/pos/cashier', { cashierId: b.id, pin: '9999' });
    expect((await call('POST', '/pos/cashier', { cashierId: b.id, pin: '4815' })).json().code).toBe(
      'PIN_LOCKED',
    );
    // B, on their own session, types the right code: not locked by the colleague's guesses.
    const own = await login(t.app, b.username!);
    const ok = await call('POST', '/pos/cashier', { cashierId: b.id, pin: '4815' }, own);
    expect(ok.statusCode).toBe(200);
  });

  it('starts the count of failures again after a right password', async () => {
    for (let i = 0; i < 4; i++) await call('POST', '/auth/unlock', { password: `faux ${i}` });
    expect((await call('POST', '/auth/unlock', { password: PASSWORD })).statusCode).toBe(204);
    // One more wrong password is the first of a new series, not the fifth.
    await call('POST', '/auth/unlock', { password: 'faux encore' });
    expect((await call('POST', '/auth/unlock', { password: PASSWORD })).statusCode).toBe(204);
  });
});
