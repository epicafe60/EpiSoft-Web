import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, member, userRole } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

async function adminHeaders() {
  const a = await createUser(t.db, { roles: ['ADMIN'] });
  return { admin: a, headers: await login(t.app, a.username!) };
}

describe('role guards (R-AUTH-06)', () => {
  it('a member without ADMIN gets 403 on admin routes', async () => {
    const u = await createUser(t.db, { roles: ['CAISSE', 'COMPTA'] });
    const headers = await login(t.app, u.username!);
    expect((await t.app.inject({ url: '/api/v1/settings', headers })).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/v1/audit', headers })).statusCode).toBe(403);
  });
});

describe('settings (R-ADM-01)', () => {
  it('returns defaults, validates, stores and audits changes', async () => {
    const { headers, admin } = await adminHeaders();
    const initial = await t.app.inject({ url: '/api/v1/settings', headers });
    expect(initial.json()['pos.defaultFloat']).toEqual({ amount: '0.00' });

    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/pos.defaultFloat',
      headers,
      payload: { amount: 'abc' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].path).toBe('amount');

    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/pos.defaultFloat',
      headers,
      payload: { amount: '150,5' },
    });
    expect(ok.json()).toEqual({ amount: '150.50' });
    const after = await t.app.inject({ url: '/api/v1/settings', headers });
    expect(after.json()['pos.defaultFloat']).toEqual({ amount: '150.50' });

    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'setting.update'));
    expect(entry).toMatchObject({
      actorId: admin.id,
      entityId: 'pos.defaultFloat',
      before: null,
      after: { amount: '150.50' },
    });
  });

  it('rejects unknown keys', async () => {
    const { headers } = await adminHeaders();
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/nope',
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('users and roles', () => {
  it('sets roles and records before/after in the audit log', async () => {
    const { headers } = await adminHeaders();
    const u = await createUser(t.db, { roles: ['CAISSE'] });
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${u.id}/roles`,
      headers,
      payload: { roles: ['CAISSE', 'ADHERENTS'] },
    });
    expect(res.statusCode).toBe(200);
    const roles = await t.db.select().from(userRole).where(eq(userRole.memberId, u.id));
    expect(roles.map((r) => r.roleCode).sort()).toEqual(['ADHERENTS', 'CAISSE']);
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'member.roles'));
    expect(entry).toMatchObject({
      before: { roles: ['CAISSE'] },
      after: { roles: ['CAISSE', 'ADHERENTS'] },
    });
  });

  it('rejects unknown roles', async () => {
    const { headers } = await adminHeaders();
    const u = await createUser(t.db);
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${u.id}/roles`,
      headers,
      payload: { roles: ['BOSS'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps at least one administrator', async () => {
    const { headers, admin } = await adminHeaders();
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${admin.id}/roles`,
      headers,
      payload: { roles: [] },
    });
    expect(res.statusCode).toBe(409);
  });

  it('searches without accents or case (R-MBR-06)', async () => {
    const { headers } = await adminHeaders();
    const u = await createUser(t.db);
    await t.db
      .update(member)
      .set({ lastName: 'DUPRÉ', firstName: 'Hélène' })
      .where(eq(member.id, u.id));
    const res = await t.app.inject({ url: '/api/v1/admin/users?q=helene dupre', headers });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ lastName: 'DUPRÉ', hasPassword: true, roles: [] });
  });
});

describe('audit log is append-only (principle 8)', () => {
  // Drizzle wraps the PostgreSQL error raised by the trigger.
  const appendOnly = { cause: { message: expect.stringMatching(/append-only/) } };

  it('refuses updates and deletes', async () => {
    const { headers } = await adminHeaders();
    await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/pos.sellToNonMembers',
      headers,
      payload: { enabled: false },
    });
    await expect(t.db.execute(sql`update app.audit_log set action = 'x'`)).rejects.toMatchObject(
      appendOnly,
    );
    await expect(t.db.execute(sql`delete from app.audit_log`)).rejects.toMatchObject(appendOnly);
    const res = await t.app.inject({ url: '/api/v1/audit?entity=setting', headers });
    expect(res.json()).toHaveLength(1);
  });
});
