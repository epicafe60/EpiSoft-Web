import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { eq } from 'drizzle-orm';
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
  await seedMembershipTypes(db);
}

/**
 * R-ADH-01 initial values, with the service products sold at the till (R-ADH-05, R-PRD-02).
 * Codes follow EpiSoft (01001, 01002, 01004) so the legacy migration updates the same rows.
 * Existing rows are left untouched: they are edited in the application.
 */
export async function seedMembershipTypes(db: DbOrTx): Promise<void> {
  const services = [
    {
      code: '01001',
      name: 'Adhésion de passage',
      salePrice: '2.00',
      type: { code: 'PASSING', label: 'De passage', durationMonths: 0, sort: 2 },
    },
    {
      code: '01002',
      name: 'Adhésion annuelle',
      salePrice: '12.00',
      type: { code: 'ANNUAL', label: 'Annuelle', durationMonths: 12, sort: 1 },
    },
    { code: '01004', name: 'Don', salePrice: '0.00', type: null },
  ];
  for (const s of services) {
    await db
      .insert(schema.product)
      .values({
        code: s.code,
        name: s.name,
        kind: 'SERVICE',
        saleCondition: 'BOTH',
        salePrice: s.salePrice,
        status: 'ACTIVE',
      })
      .onConflictDoNothing({ target: schema.product.code });
    if (!s.type) continue;
    const [p] = await db
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(eq(schema.product.code, s.code));
    await db
      .insert(schema.membershipType)
      .values({ ...s.type, price: s.salePrice, productId: p!.id })
      .onConflictDoNothing({ target: schema.membershipType.code });
  }
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
