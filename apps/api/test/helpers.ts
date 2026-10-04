import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { createDb, createPool, member, seedMembershipTypes, userRole, type Db } from '@episoft/db';
import { CSRF_HEADER, type RoleCode } from '@episoft/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { hashPassword } from '../src/lib/tokens';

export const PASSWORD = 'correct horse battery';

export async function setupTestApp() {
  const pool = createPool(inject('databaseUrl'), 4);
  const db = createDb(pool);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    APP_URL: 'http://test.local',
    AUTH_RATE_LIMIT_MAX: '100000',
  });
  const app = await buildApp(db, config);
  await app.ready();
  return {
    app,
    db,
    config,
    async reset() {
      // audit_log is append-only (trigger), so TRUNCATE is the only way to clear it.
      await db.execute(sql`truncate app.audit_log, app.login_log, app.session, app.password_reset_token,
        app.email_outbox, app.import_mapping, app.setting, app.user_role, app.member, app.household cascade`);
      // CASCADE reaches the catalogue (member → supplier → product): restore the seeds.
      await seedMembershipTypes(db);
    },
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

let seq = 0;
export async function createUser(
  db: Db,
  opts: {
    roles?: RoleCode[];
    status?: 'NEW' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
    email?: string | null;
  } = {},
) {
  seq++;
  const [m] = await db
    .insert(member)
    .values({
      lastName: `NOM${seq}`,
      firstName: `Prénom${seq}`,
      username: `user${seq}`,
      email: opts.email === undefined ? `user${seq}@example.org` : opts.email,
      status: opts.status ?? 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    })
    .returning();
  if (opts.roles?.length) {
    await db.insert(userRole).values(opts.roles.map((roleCode) => ({ memberId: m!.id, roleCode })));
  }
  return m!;
}

export const csrf = { [CSRF_HEADER]: '1' };

/** Logs in and returns the cookie header to send with later requests. */
export async function login(
  app: Awaited<ReturnType<typeof setupTestApp>>['app'],
  username: string,
  password = PASSWORD,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: csrf,
    payload: { username, password },
  });
  if (res.statusCode !== 204) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'episoft_session')!;
  return { cookie: `${cookie.name}=${cookie.value}`, ...csrf };
}
