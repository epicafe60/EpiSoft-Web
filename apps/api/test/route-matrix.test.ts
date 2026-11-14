import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_CODES, type RoleCode } from '@episoft/shared';
import { createUser, csrf, login, setupTestApp } from './helpers';

// Audit KV2 (S01, C05): the access of EVERY route, generated from the routes the application
// registers, so that a route added tomorrow is tested without anyone writing a line.
//  - without a session, whatever the way its path is written, nothing answers;
//  - a signed-in person without the role of a route is refused before anything of the request
//    (body, parameters) is looked at;
//  - an administrator is never refused by the role guard of a route.

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
  await t.reset();
});
afterAll(() => t.close());

type Route = { method: string; url: string; public: boolean; roles: RoleCode[] | null };
const routes = (): Route[] => t.app.routeAccess.map((r) => ({ ...r })) as Route[];

const UUID = '0190a0a0-0000-7000-8000-000000000001';
/** A concrete path for a route template: every `:param` gets a plausible value. */
const concrete = (url: string) => url.replace(/:\w+/g, UUID);

/** The ways a hostile client may write the same path. */
function variants(path: string): string[] {
  const rest = path.replace(/^\/api/, '');
  return [
    path,
    `/%61pi${rest}`,
    `/a%70i${rest}`,
    `/%41PI${rest}`,
    `/%61%70%69${rest}`,
    `/%2561pi${rest}`,
    `${path}/`,
    `${path}?x=1`,
    `${path};x=1`,
    `/api/./${rest.replace(/^\//, '')}`,
  ];
}

const send = (method: string, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as 'GET', url, headers });

describe('without a session, no route answers, however its path is written', () => {
  it('refuses every non-public route on every variant of its path', async () => {
    const targets = routes().filter((r) => !r.public);
    expect(targets.length).toBeGreaterThan(200);
    const bad: string[] = [];
    for (const r of targets) {
      for (const v of variants(concrete(r.url))) {
        for (const headers of [{}, csrf]) {
          const res = await send(r.method, v, headers);
          // 401 / 403 (no session, no CSRF header) or 404 (a variant the router does not know):
          // never data, never a validation message, never a server error.
          if (![401, 403, 404].includes(res.statusCode))
            bad.push(`${r.method} ${v} → ${res.statusCode}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('a state-changing call without the anti-CSRF header is refused before the session is read', async () => {
    for (const r of routes().filter((x) => x.method !== 'GET')) {
      const res = await send(r.method, concrete(r.url));
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(r.public ? res.statusCode : 403);
    }
  }, 120_000);
});

describe('a signed-in person without the role of a route is refused', () => {
  it('every guarded route answers 403 to someone who holds none of its roles', async () => {
    const guarded = routes().filter((r) => r.roles && r.roles.length);
    expect(guarded.length).toBeGreaterThan(150);
    const heads = new Map<string, Record<string, string>>();
    const as = async (roles: RoleCode[]) => {
      const key = roles.join(',');
      if (!heads.has(key))
        heads.set(key, await login(t.app, (await createUser(t.db, { roles })).username!));
      return heads.get(key)!;
    };
    const bad: string[] = [];
    for (const r of guarded) {
      // Everything the person could hold except the roles of the route (and the administrator).
      const others = ROLE_CODES.filter((c) => c !== 'ADMIN' && !r.roles!.includes(c));
      for (const roles of [[], others]) {
        const h = await as(roles);
        // An empty body: if the role were checked after the body, this would answer 400.
        const res = await t.app.inject({
          method: r.method as 'GET',
          url: concrete(r.url),
          headers: h,
          ...(r.method === 'GET' ? {} : { payload: {} }),
        });
        if (res.statusCode !== 403)
          bad.push(`${r.method} ${r.url} as [${roles.join(',')}] → ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('an administrator is never refused by the role guard of a read route', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const bad: string[] = [];
    for (const r of routes().filter((x) => x.method === 'GET' && x.roles?.length)) {
      const res = await t.app.inject({ method: 'GET', url: concrete(r.url), headers: h });
      if (res.statusCode === 401 || res.statusCode === 403)
        bad.push(`GET ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);
});

describe('each role a route declares is let through by its guard', () => {
  it('holding one declared role is enough, on every read route', async () => {
    const bad: string[] = [];
    const heads = new Map<RoleCode, Record<string, string>>();
    for (const r of routes().filter((x) => x.method === 'GET' && x.roles?.length)) {
      for (const role of r.roles!) {
        if (!heads.has(role))
          heads.set(
            role,
            await login(t.app, (await createUser(t.db, { roles: [role] })).username!),
          );
        const res = await t.app.inject({
          method: 'GET',
          url: concrete(r.url),
          headers: heads.get(role)!,
        });
        // Anything but a refusal for lack of rights (404 for an unknown id, 400 for a parameter…).
        if (res.statusCode === 401 || res.statusCode === 403)
          bad.push(`GET ${r.url} as ${role} → ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);
});
