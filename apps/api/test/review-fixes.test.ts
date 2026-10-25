import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, emailOutbox, errorLog, syncRejection, type Db } from '@episoft/db';
import { DEFAULT_THRESHOLDS, type SyncOp } from '@episoft/shared';
import { alertNow } from '../src/lib/alerts';
import { isLocalAddress } from '../src/modules/admin/monitoring';
import { createUser, login, PASSWORD, setupTestApp } from './helpers';

// Fixes from the code review: lockout per account, local-only backup report, a « not yet » that
// does not wait for ever, audited bulk exports and Surveillance actions, thresholds read by the
// checks, alerts limited even without e-mail.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

async function resetAll(db: Db) {
  await t.reset();
  await db.execute(sql`truncate app.sync_rejection, app.integrity_run, app.error_log, app.backup_run,
    app.job_run, app.sync_receipt, app.sale_payment, app.sale_line, app.sale, app.cash_count,
    app.cash_session, app.pos_device cascade`);
}
beforeEach(() => resetAll(t.db));

const csrf = { 'x-episoft-csrf': '1' };
const loginAs = (username: string, password: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: csrf,
    payload: { username, password },
  });

describe('login lockout', () => {
  it('counts the failures on the account, whether the user name or the e-mail was typed', async () => {
    const u = await createUser(t.db, { email: 'compte@example.org' });
    const codes: number[] = [];
    // Alternate the two identifiers: the lockout must come as fast as with one of them.
    for (let i = 0; i < 12; i++)
      codes.push(
        (await loginAs(i % 2 ? u.username! : 'compte@example.org', 'mauvais mot de passe'))
          .statusCode,
      );
    expect(codes).toContain(429);
    const firstLock = codes.indexOf(429);
    // The right password is refused too while the account is locked.
    expect((await loginAs(u.username!, PASSWORD)).statusCode).toBe(429);
    expect((await loginAs('compte@example.org', PASSWORD)).statusCode).toBe(429);
    expect(firstLock).toBeLessThanOrEqual(10);
  });
});

describe('backup report', () => {
  it('accepts only the server itself or the local network', async () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.10')).toBe(true);
    expect(isLocalAddress('172.18.0.1')).toBe(true);
    expect(isLocalAddress('10.0.0.5')).toBe(true);
    expect(isLocalAddress('fd12:3456::1')).toBe(true);
    expect(isLocalAddress('172.32.0.1')).toBe(false);
    expect(isLocalAddress('90.12.34.56')).toBe(false);
    expect(isLocalAddress('2a01:cb00::1')).toBe(false);

    const send = (remoteAddress: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/internal/backup-report',
        remoteAddress,
        headers: { ...csrf, authorization: 'Bearer test-backup-token-0123456789' },
        payload: { kind: 'BACKUP', ok: true },
      });
    expect((await send('90.12.34.56')).statusCode).toBe(404); // from the Internet, even with the token
    expect((await send('127.0.0.1')).statusCode).toBe(204);
  });
});

describe('an operation waiting for what it depends on', () => {
  let cashier: Headers;
  let deviceId: string;
  let cashierId: string;
  beforeEach(async () => {
    const c = await createUser(t.db, { roles: ['CAISSE'] });
    cashierId = c.id;
    cashier = await login(t.app, c.username!);
    deviceId = (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/pos/devices',
        headers: cashier,
        payload: { name: 'ATTENTE' },
      })
    ).json().id;
  });
  const cancel = (at: Date): SyncOp => ({
    kind: 'SALE_CANCEL',
    id: randomUUID(),
    deviceSeq: 5,
    payload: {
      cancelSaleId: randomUUID(),
      saleId: randomUUID(),
      sessionId: randomUUID(),
      cashierId,
      at: at.toISOString(),
      provisionalNumber: 'ATTENTE-5',
    },
  });
  const push = (op: SyncOp) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: cashier,
      payload: { deviceId, ops: [op] },
    });

  it('is « not yet » while recent', async () => {
    expect((await push(cancel(new Date()))).statusCode).toBe(409);
    expect(await t.db.select().from(syncRejection)).toHaveLength(0);
  });

  it('is refused and recorded after a day, so the till is no longer blocked', async () => {
    const res = await push(cancel(new Date(Date.now() - 30 * 3_600_000)));
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ status: 'REJECTED' });
    expect(res.json().results[0].error).toContain('attendu plus de 24 h');
    expect(await t.db.select().from(syncRejection)).toHaveLength(1);
  });
});

describe('bulk exports and Surveillance actions leave a trace', () => {
  it('journals the export of every member and of every cagnotte', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    expect((await t.app.inject({ url: '/api/v1/members.xlsx', headers: h })).statusCode).toBe(200);
    expect(
      (await t.app.inject({ url: '/api/v1/admin/wallet-report.xlsx', headers: h })).statusCode,
    ).toBe(200);
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['member.export_all', 'wallet.report_export']));
  });

  it('limits the bulk member export to ten a minute', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push((await t.app.inject({ url: '/api/v1/members.xlsx', headers: h })).statusCode);
    expect(codes[10]).toBe(429);
  });

  it('journals putting aside a server error and sending an e-mail again', async () => {
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const [e] = await t.db
      .insert(errorLog)
      .values({ fingerprint: 'f', message: 'm', lastRef: 'ABC123' })
      .returning();
    const [m] = await t.db
      .insert(emailOutbox)
      .values({ to: 'x@example.org', subject: 'Raté', html: '', status: 'FAILED', lastError: 'x' })
      .returning();
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/errors/${e!.id}/ack`,
      headers: admin,
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/emails/${m!.id}/resend`,
      headers: admin,
    });
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['error.ack', 'email.resend']));
  });
});

describe('the checks read the thresholds of the administration', () => {
  const count = async (id: string, h: Headers) =>
    (
      (await t.app.inject({ url: '/api/v1/admin/integrity', headers: h })).json() as {
        checks: { id: string; count: number }[];
      }
    ).checks.find((c) => c.id === id)!.count;

  it('SES-01 follows the « session ouverte depuis plus de » threshold', async () => {
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const [d] = (
      await t.db.execute(
        sql`insert into app.pos_device (id, name) values (gen_random_uuid(), 'SEUIL') returning id`,
      )
    ).rows as { id: string }[];
    await t.db.execute(sql`insert into app.cash_session (id, device_id, opened_at, opening_float)
      values (gen_random_uuid(), ${d!.id}, now() - interval '10 hours', 0)`);
    expect(await count('SES-01', admin)).toBe(0); // default: 24 h
    const saved = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/controls.thresholds',
      headers: admin,
      payload: { ...DEFAULT_THRESHOLDS, sessionHours: 8 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await count('SES-01', admin)).toBe(1);
  });
});

describe('an urgent alert', () => {
  it('goes out at most once an hour for the same subject, even when nobody has an e-mail', async () => {
    await createUser(t.db, { roles: ['ADMIN'], email: null });
    const send = () =>
      alertNow(
        t.db,
        t.config,
        ['ADMIN'],
        { subject: 'Test', lines: ['x'] },
        { title: 't', body: 'b' },
      );
    expect(await send()).toBe(1);
    expect(await send()).toBe(0);
    expect(await send()).toBe(0);
  });
});

describe('a device the server does not accept', () => {
  const pushTo = async (deviceId: string) => {
    const user = await createUser(t.db, { roles: ['CAISSE'] });
    const h = await login(t.app, user.username!);
    const sessionId = randomUUID();
    return t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: h,
      payload: {
        deviceId,
        ops: [
          {
            kind: 'SESSION_OPEN',
            id: sessionId,
            deviceSeq: 1,
            payload: {
              sessionId,
              openedBy: user.id,
              openedAt: new Date().toISOString(),
              openingFloat: '50.00',
            },
          },
        ],
      },
    });
  };

  it('answers with a code the till can act on when the device is unknown', async () => {
    const res = await pushTo(randomUUID());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'DEVICE_UNKNOWN' });
    expect(res.json().detail).toContain('Redéclarez');
  });

  it('answers with another code when the device was switched off', async () => {
    const [d] = (
      await t.db.execute(
        sql`insert into app.pos_device (id, name, active) values (gen_random_uuid(), 'ETEINTE', false) returning id`,
      )
    ).rows as { id: string }[];
    const res = await pushTo(d!.id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'DEVICE_DISABLED' });
  });

  it('leaves the other 400 errors without a code', async () => {
    const user = await createUser(t.db, { roles: ['CAISSE'] });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: await login(t.app, user.username!),
      payload: { deviceId: 'pas-un-uuid', ops: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBeUndefined();
  });
});
