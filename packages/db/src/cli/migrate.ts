import { createDb, createPool, loadEnv, migrateAndSeed, requireEnv } from '../index';

loadEnv();
const pool = createPool(requireEnv('DATABASE_URL'), 1);
try {
  await migrateAndSeed(createDb(pool));
  console.log('Migrations appliquées.');
} finally {
  await pool.end();
}
