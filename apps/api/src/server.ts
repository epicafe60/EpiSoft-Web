import { createDb, createPool, loadEnv, migrateAndSeed } from '@episoft/db';
import { buildApp } from './app';
import { loadConfig } from './config';
import { startMailer } from './lib/mail';

loadEnv();
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);

if (config.MIGRATE_ON_START) await migrateAndSeed(db, config.MIGRATIONS_DIR);

const app = await buildApp(db, config, {
  logger:
    config.NODE_ENV === 'development'
      ? {
          level: config.LOG_LEVEL,
          transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
        }
      : { level: config.LOG_LEVEL },
});
const stopMailer = startMailer(db, config, app.log);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} reçu, arrêt.`);
  stopMailer();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
