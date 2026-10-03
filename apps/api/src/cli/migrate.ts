// Applies database migrations (used by the Docker image before the server starts).
import { createDb, createPool, loadEnv, migrateAndSeed } from '@episoft/db';
import { loadConfig } from '../config';

loadEnv();
const config = loadConfig();
const pool = createPool(config.DATABASE_URL, 1);
try {
  await migrateAndSeed(createDb(pool), config.MIGRATIONS_DIR);
  console.log('Migrations appliquées.');
} finally {
  await pool.end();
}
