import { readFileSync } from 'node:fs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type { TestProject } from 'vitest/node';
import { createDb, createPool, migrateAndSeed, REPO_ROOT } from '@episoft/db';

declare module 'vitest' {
  export interface ProvidedContext {
    /** A superuser on the same database: the tests preparing or clearing their data. */
    databaseUrl: string;
    /** What the application uses, as in production (audit KV2, D01): data only, no structure. */
    appDatabaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

// Passwords of a throwaway container, never used anywhere else.
const APP_PASSWORD = 'app-test-only';
const OWNER_PASSWORD = 'owner-test-only';

const withUser = (url: string, user: string, password: string, database: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
};

/**
 * A throwaway PostgreSQL 17 (spec §7.2: Testcontainers), laid out as the server: the database and
 * the schema created as deploy/db/init/01-episoft.sh does, the migrations applied by episoft_app,
 * then deploy/db/split-roles.sql replayed as is (D01). The application then runs as episoft_app
 * with the rights it has in production after the switch.
 */
export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17').start();
  const admin = container.getConnectionUri();

  const adminPool = createPool(admin, 1, 'migration');
  try {
    const db = createDb(adminPool);
    // Constants of the test, not user values: CREATE ROLE takes no bind parameter.
    await db.execute(sql.raw(`create role episoft_app login password '${APP_PASSWORD}'`));
    await db.execute(sql.raw(`create role episoft_ro login`));
    await db.execute(sql.raw(`create database episoft owner episoft_app`));
  } finally {
    await adminPool.end();
  }
  const setupPool = createPool(withUser(admin, 'test', 'test', 'episoft'), 1, 'migration');
  try {
    const db = createDb(setupPool);
    await db.execute(sql`revoke all on schema public from public`);
    await db.execute(sql`create schema app authorization episoft_app`);
    await db.execute(sql`alter role episoft_app set search_path = app, public`);
  } finally {
    await setupPool.end();
  }

  const appUrl = withUser(admin, 'episoft_app', APP_PASSWORD, 'episoft');
  const migrationPool = createPool(appUrl, 1, 'migration');
  try {
    await migrateAndSeed(createDb(migrationPool));
  } finally {
    await migrationPool.end();
  }

  await container.copyContentToContainer([
    {
      content: readFileSync(`${REPO_ROOT}/deploy/db/split-roles.sql`, 'utf8'),
      target: '/tmp/split-roles.sql',
    },
  ]);
  const run = await container.exec([
    'psql',
    '-U',
    'test',
    '-d',
    'episoft',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    `owner_pw=${OWNER_PASSWORD}`,
    '-f',
    '/tmp/split-roles.sql',
  ]);
  if (run.exitCode !== 0) throw new Error(`split-roles.sql failed:\n${run.output}`);

  project.provide('databaseUrl', withUser(admin, 'test', 'test', 'episoft'));
  project.provide('appDatabaseUrl', appUrl);
  return async () => {
    await container?.stop();
  };
}
