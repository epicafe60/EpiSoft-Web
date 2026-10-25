import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { createDb, createPool, member, seedMembershipTypes, userRole, type Db } from '@episoft/db';
import { CSRF_HEADER, type RoleCode } from '@episoft/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { hashPassword } from '../src/lib/tokens';

export const PASSWORD = 'correct horse battery';

export async function setupTestApp() {
  // The application writes through its own connections (labelled « app » in data_change); the
  // tests prepare their data through others (« test »), so that the check below only looks at
  // what the application wrote.
  const appPool = createPool(inject('databaseUrl'), 4);
  const pool = createPool(inject('databaseUrl'), 2, 'test');
  const db = createDb(pool);
  // What the background jobs use in production: changes labelled « job » (see server.ts).
  const jobsPool = createPool(inject('databaseUrl'), 2, 'job');
  const jobsDb = createDb(jobsPool);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    APP_URL: 'http://test.local',
    AUTH_RATE_LIMIT_MAX: '100000',
    BACKUP_REPORT_TOKEN: 'test-backup-token-0123456789',
  });
  const app = await buildApp(createDb(appPool), config);
  await app.ready();
  return {
    app,
    db,
    jobsDb,
    config,
    async reset() {
      const unattributed = await expectAllAttributed(db).catch((e: Error) => e);
      // audit_log and data_change are append-only (trigger): TRUNCATE is the only way to clear them.
      await db.execute(sql`truncate app.audit_log, app.data_change, app.login_log, app.session, app.password_reset_token,
        app.email_outbox, app.import_mapping, app.setting, app.user_role, app.member, app.household cascade`);
      // CASCADE reaches the catalogue (member → supplier → product): restore the seeds.
      await seedMembershipTypes(db);
      // Reported once, by the test that follows the one that left them.
      if (unattributed) throw unattributed;
    },
    async close() {
      try {
        await expectAllAttributed(db);
      } finally {
        await app.close();
        await appPool.end();
        await pool.end();
        await jobsPool.end();
      }
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

/**
 * R-ADM-05: every row the application changed belongs to a transaction that recorded an action
 * in the journal. Fails with the tables concerned (an `audit()` forgotten, or called outside the
 * transaction of the change).
 */
export async function expectAllAttributed(db: Db): Promise<void> {
  const { rows } = await db.execute<{ table_name: string; op: string; n: number }>(sql`
    select d.table_name, d.op, count(*)::int as n
    from app.data_change d
    where d.source = 'app'
      -- the acknowledgement of an operation that changed nothing else (an opening replayed)
      and d.table_name <> 'sync_receipt' and not exists (select 1 from app.audit_log a where a.xact = d.xact)
    group by 1, 2 order by 1, 2`);
  if (rows.length)
    throw new Error(
      `Modifications faites par l’application sans action dans le journal : ${rows
        .map((r) => `${r.table_name} ${r.op} ×${r.n}`)
        .join(', ')}`,
    );
}
