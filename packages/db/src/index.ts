import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_CODES, ROLE_LABELS } from '@episoft/shared';
import * as schema from './schema';

export * as schema from './schema';
export * from './schema';
export { loadEnv, requireEnv, REPO_ROOT } from './env';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

// numeric and bigint values are returned as strings by default; keep it that way (exact money).
export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/** Applies pending migrations, then the reference data every install needs. */
export async function migrateAndSeed(db: Db, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
  await migrate(db, {
    migrationsFolder,
    migrationsSchema: 'app',
    migrationsTable: '__drizzle_migrations',
  });
  await seedRoles(db);
}

export async function seedRoles(db: DbOrTx): Promise<void> {
  const rows = ROLE_CODES.map((code) => ({ code, label: ROLE_LABELS[code] }));
  for (const row of rows) {
    await db
      .insert(schema.role)
      .values(row)
      .onConflictDoUpdate({ target: schema.role.code, set: { label: row.label } });
  }
}
