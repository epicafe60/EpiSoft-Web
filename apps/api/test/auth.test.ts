import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, emailOutbox, loginLog, member, passwordResetToken } from '@episoft/db';
import { createUser, csrf, login, PASSWORD, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const post = (url: string, payload: unknown, headers: Record<string, string> = csrf) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers });

describe('login (R-AUTH-01, R-AUTH-07)', () => {
  it('opens a session with an HttpOnly, SameSite=Lax cookie and logs the login', async () => {
    const u = await createUser(t.db, { roles: ['CAISSE'] });
    const res = await post('/api/v1/auth/login', {
      username: u.username!.toUpperCase(),
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(204);
    const cookie = res.cookies.find((c) => c.name === 'episoft_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');

    const me = await t.app.inject({
      url: '/api/v1/me',
      headers: { cookie: `episoft_session=${cookie.value}` },
    });
    expect(me.json()).toMatchObject({ id: u.id, roles: ['CAISSE'] });

    const logs = await t.db.select().from(loginLog).where(eq(loginLog.memberId, u.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ success: true });
  });

  it('R-EVO-42: accepts the e-mail of the membership as identifier', async () => {
    const u = await createUser(t.db, { roles: ['CAISSE'], email: 'Marie.Dupont@Example.org' });
    const res = await post('/api/v1/auth/login', {
      username: 'marie.dupont@example.org',
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(204);
    const bad = await post('/api/v1/auth/login', {
      username: 'marie.dupont@example.org',
      password: 'wrong password',
    });
    expect(bad.statusCode).toBe(401);
    expect(u.email).toBe('Marie.Dupont@Example.org');
  });

  it('R-EVO-42: the password link is also asked with the e-mail', async () => {
    const u = await createUser(t.db, { email: 'oubli@example.org' });
    const res = await post('/api/v1/auth/password/forgot', { username: 'OUBLI@example.org' });
    expect(res.statusCode).toBe(204);
    const [mail] = await t.db.select().from(emailOutbox);
    expect(mail).toMatchObject({ to: 'oubli@example.org' });
    expect(u.id).toBeTruthy();
    // An unknown address gets the same answer and no e-mail.
    const none = await post('/api/v1/auth/password/forgot', { username: 'nobody@example.org' });
    expect(none.statusCode).toBe(204);
    expect(await t.db.select().from(emailOutbox)).toHaveLength(1);
  });

  it('refuses a wrong password with a generic message', async () => {
    const u = await createUser(t.db);
    const res = await post('/api/v1/auth/login', {
      username: u.username,
      password: 'wrong password',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().detail).toBe('Identifiant ou mot de passe incorrect.');
  });

  it('gives the same answer for an unknown user', async () => {
    const res = await post('/api/v1/auth/login', { username: 'nobody', password: 'whatever123' });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toBe('Identifiant ou mot de passe incorrect.');
  });

  it('refuses inactive members', async () => {
    const u = await createUser(t.db, { status: 'INACTIVE' });
    expect(
      (await post('/api/v1/auth/login', { username: u.username, password: PASSWORD })).statusCode,
    ).toBe(401);
  });

  it('CA §4.1: a QR code is not a password', async () => {
    const u = await createUser(t.db);
    await t.db.update(member).set({ qrTokenHash: 'abc' }).where(eq(member.id, u.id));
    expect(
      (await post('/api/v1/auth/login', { username: u.username, password: 'abc' })).statusCode,
    ).toBe(401);
  });

  it('logout ends the session and records the logout time', async () => {
    const u = await createUser(t.db);
    const headers = await login(t.app, u.username!);
    expect((await post('/api/v1/auth/logout', {}, headers)).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(401);
    const [log] = await t.db.select().from(loginLog).where(eq(loginLog.memberId, u.id));
    expect(log!.logoutAt).not.toBeNull();
  });

  it('a member deactivated after login loses access immediately', async () => {
    const u = await createUser(t.db);
    const headers = await login(t.app, u.username!);
    await t.db.update(member).set({ status: 'ARCHIVED' }).where(eq(member.id, u.id));
    expect((await t.app.inject({ url: '/api/v1/me', headers })).statusCode).toBe(401);
  });
});

describe('R-AUTH-03 lockout', () => {
  it('blocks the username after 5 failures, even with the right password', async () => {
    const u = await createUser(t.db);
    for (let i = 0; i < 5; i++) {
      expect(
        (await post('/api/v1/auth/login', { username: u.username, password: 'wrong password' }))
          .statusCode,
      ).toBe(401);
    }
    const res = await post('/api/v1/auth/login', { username: u.username, password: PASSWORD });
    expect(res.statusCode).toBe(429);
    // The attempts are dated by the database: in a test container its clock may lead the
    // application's by a moment, and the rounded-up delay then reads 16 minutes.
    expect(res.json().detail).toMatch(/Réessayez dans 1[56] min/);
  });
});

describe('CSRF and default deny (§5.5, R-AUTH-06)', () => {
  it('rejects a state-changing request without the CSRF header', async () => {
    const u = await createUser(t.db);
    const res = await post('/api/v1/auth/login', { username: u.username, password: PASSWORD }, {});
    expect(res.statusCode).toBe(403);
  });

  it('API routes require a session unless public', async () => {
    expect((await t.app.inject({ url: '/api/v1/me' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/v1/settings' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/v1/health' })).statusCode).toBe(200);
  });
});

describe('R-AUTH-02 password reset', () => {
  it('sends a link that sets the password once and closes other sessions', async () => {
    const u = await createUser(t.db);
    const old = await login(t.app, u.username!);

    expect((await post('/api/v1/auth/password/forgot', { username: u.username })).statusCode).toBe(
      204,
    );
    const [mail] = await t.db.select().from(emailOutbox);
    expect(mail!.to).toBe(u.email);
    const token = decodeURIComponent(/jeton=([^\s"<]+)/.exec(mail!.text!)![1]!);

    const tooShort = await post('/api/v1/auth/password/reset', { token, password: 'short' });
    expect(tooShort.statusCode).toBe(400);

    const ok = await post('/api/v1/auth/password/reset', {
      token,
      password: 'a brand new password',
    });
    expect(ok.statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/v1/me', headers: old })).statusCode).toBe(401);
    await login(t.app, u.username!, 'a brand new password');

    const reuse = await post('/api/v1/auth/password/reset', {
      token,
      password: 'another new password',
    });
    expect(reuse.statusCode).toBe(400);

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'password.reset'));
    expect(audits).toHaveLength(1);
  });

  it('refuses an expired link', async () => {
    const u = await createUser(t.db);
    await post('/api/v1/auth/password/forgot', { username: u.username });
    await t.db.update(passwordResetToken).set({ expiresAt: new Date(Date.now() - 1000) });
    const [mail] = await t.db.select().from(emailOutbox);
    const token = decodeURIComponent(/jeton=([^\s"<]+)/.exec(mail!.text!)![1]!);
    expect(
      (await post('/api/v1/auth/password/reset', { token, password: 'a brand new password' }))
        .statusCode,
    ).toBe(400);
  });

  it('does not reveal unknown usernames', async () => {
    expect((await post('/api/v1/auth/password/forgot', { username: 'nobody' })).statusCode).toBe(
      204,
    );
    expect(await t.db.select().from(emailOutbox)).toHaveLength(0);
  });
});

describe('OpenAPI (§8.1)', () => {
  it('documents the routes outside production', async () => {
    const res = await t.app.inject({ url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/api/v1/auth/login');
  });
});
