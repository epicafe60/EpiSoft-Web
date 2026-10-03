import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
  await t.reset();
});
afterAll(() => t.close());

describe('administrator impersonation', () => {
  it('acts as another user with their rights, audited, and comes back', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const other = await createUser(t.db, { roles: ['ADMIN'] });
    const treasurer = await createUser(t.db, { roles: ['COMPTA'] });
    const h = await login(t.app, admin.username!);
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });

    // Not oneself, not another administrator.
    expect((await call('POST', `/admin/users/${admin.id}/impersonate`)).statusCode).toBe(400);
    expect((await call('POST', `/admin/users/${other.id}/impersonate`)).statusCode).toBe(400);

    expect((await call('POST', `/admin/users/${treasurer.id}/impersonate`)).statusCode).toBe(200);
    const me = (await call('GET', '/me')).json();
    expect(me.id).toBe(treasurer.id);
    expect(me.roles).toEqual(['COMPTA']);
    expect(me.impersonator).toMatchObject({ id: admin.id });
    // The treasurer's rights apply: no administration, but accounting.
    expect((await call('GET', '/admin/users')).statusCode).toBe(403);
    expect((await call('GET', '/accounts')).statusCode).toBe(200);
    // No nesting, and an administrator cannot impersonate from inside.
    expect((await call('POST', `/admin/users/${other.id}/impersonate`)).statusCode).toBe(403);

    // An audited action done meanwhile names the real administrator and the member.
    expect(
      (await call('POST', '/journals', { code: 'ZZ', label: 'Test usurpation', active: true }))
        .statusCode,
    ).toBe(200);
    const [row] = await t.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    expect(row).toMatchObject({ actorId: admin.id, onBehalfOfId: treasurer.id });

    expect((await call('POST', '/auth/impersonate/stop')).statusCode).toBe(200);
    expect((await call('GET', '/me')).json()).toMatchObject({ id: admin.id, impersonator: null });
    expect((await call('POST', '/auth/impersonate/stop')).statusCode).toBe(409);

    const trail = await t.db.select().from(auditLog).where(eq(auditLog.actorId, admin.id));
    const actions = trail.map((r) => r.action);
    expect(actions).toContain('impersonate.start');
    expect(actions).toContain('impersonate.stop');
  });
});
