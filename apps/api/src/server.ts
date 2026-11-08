import { createDb, createPool, loadEnv, migrateAndSeed } from '@episoft/db';
import { buildApp } from './app';
import { loadConfig } from './config';
import { startMailer } from './lib/mail';
import { startReminderJob } from './modules/members/reminders';
import { startIntegrityJob } from './modules/admin/integrity';
import { startDailyDigestJob } from './modules/admin/digest';
import { startInvoiceAlertJob } from './modules/supplies/invoices';

loadEnv();
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
// The background jobs write through their own connections: their changes are labelled « job »
// in data_change, and are not mistaken for changes made by hand (integrity check AUD-01).
const jobsPool = createPool(config.DATABASE_URL, 3, 'job');
const jobsDb = createDb(jobsPool);

if (config.MIGRATE_ON_START) {
  const migrationPool = createPool(
    config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
    1,
    'migration',
  );
  await migrateAndSeed(createDb(migrationPool), config.MIGRATIONS_DIR);
  await migrationPool.end();
}

const app = await buildApp(db, config, {
  logger:
    config.NODE_ENV === 'development'
      ? {
          level: config.LOG_LEVEL,
          transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
        }
      : { level: config.LOG_LEVEL },
});
const stopMailer = startMailer(jobsDb, config, app.log);
const stopReminders = startReminderJob(jobsDb, app.log, config);
const stopInvoiceAlerts = startInvoiceAlertJob(jobsDb, app.log);
const stopIntegrity = startIntegrityJob(jobsDb, app.log);
const stopDigest = startDailyDigestJob(jobsDb, config, app.log);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} reçu, arrêt.`);
  stopMailer();
  stopReminders();
  stopInvoiceAlerts();
  stopIntegrity();
  stopDigest();
  await app.close();
  await pool.end();
  await jobsPool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
