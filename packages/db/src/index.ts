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
// `source` labels every change made through this pool in data_change (null = made by hand).
export function createPool(url: string, max = 10, source = 'app'): pg.Pool {
  return new pg.Pool({ connectionString: url, max, options: `-c episoft.source=${source}` });
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
  await seedAccounting(db);
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

/** Journals, template categories and the accounts every install needs (spec §2.4.7, §4.11). */
export async function seedAccounting(db: DbOrTx): Promise<void> {
  const journals = [
    ['ACH', 'ACHATS'],
    ['BNQ', 'BANQUE'],
    ['CAI', 'CAISSE'],
    ['VTE', 'VENTES'],
    ['OD', 'OPÉRATIONS DIVERSES'],
    ['RAN', 'REPORTS À NOUVEAU'],
  ] as const;
  for (const [i, [code, label]] of journals.entries()) {
    await db
      .insert(schema.journal)
      .values({ code, label, sort: i })
      .onConflictDoNothing({ target: schema.journal.code });
  }
  const accounts: [string, string, 'D' | 'C' | 'M'][] = [
    ['101000', 'Capital associatif', 'C'],
    ['110000', 'Report à nouveau créditeur', 'C'],
    ['119000', 'Report à nouveau débiteur', 'D'],
    ['120000', 'Résultat de l’exercice (excédent)', 'C'],
    ['129000', 'Résultat de l’exercice (perte)', 'D'],
    ['370000', 'Stock de marchandises', 'D'],
    ['401000', 'Fournisseurs divers', 'M'],
    ['411000', 'Cagnottes des adhérents', 'M'],
    ['511200', 'Chèques à encaisser', 'D'],
    ['511300', 'Cartes à encaisser', 'D'],
    ['512001', 'Banque', 'D'],
    ['531000', 'Caisse', 'D'],
    ['603700', 'Variation de stock de marchandises', 'D'],
    ['607000', 'Achats de marchandises', 'D'],
    ['627100', 'Frais sur titres et services bancaires', 'D'],
    ['627800', 'Autres frais bancaires', 'D'],
    ['658000', 'Charges de gestion courante (écarts de caisse)', 'D'],
    ['707000', 'Ventes de marchandises', 'C'],
    ['754000', 'Dons', 'C'],
    ['756000', 'Cotisations', 'C'],
    ['758000', 'Produits de gestion courante (écarts de caisse)', 'C'],
    ['890000', 'Bilan d’ouverture', 'M'],
  ];
  for (const [number, label, normalSide] of accounts) {
    await db
      .insert(schema.account)
      .values({ number, label, normalSide })
      .onConflictDoNothing({ target: schema.account.number });
  }
  const categories = [
    ['ACH', 'Achats de marchandises'],
    ['FRA', 'Autres achats'],
    ['CHF', 'Charges fixes (loyers, abonnements…)'],
    ['BNQ', 'Frais bancaires'],
    ['AUT', 'Autres'],
    ['ADH', 'Comptes adhérents'],
    ['REC', 'Produits'],
    ['RAN', 'Reports à nouveau'],
  ] as const;
  for (const [i, [code, label]] of categories.entries()) {
    await db
      .insert(schema.entryTemplateCategory)
      .values({ code, label, sort: i + 1 })
      .onConflictDoNothing({ target: schema.entryTemplateCategory.code });
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
