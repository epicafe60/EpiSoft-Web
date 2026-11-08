import { createDb, createPool, loadEnv, migrateAndSeed, requireEnv } from '../index';

loadEnv();
// Audit KV2, D01: the owner of the schema applies the migrations when it is configured.
const pool = createPool(
  process.env.MIGRATION_DATABASE_URL || requireEnv('DATABASE_URL'),
  1,
  'migration',
);
try {
  await migrateAndSeed(createDb(pool));
  console.log('Migrations appliquées.');
} finally {
  await pool.end();
}
