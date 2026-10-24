import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().default(3000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: bool.default('false'),
  /** Folder of the built web app, served by the API in production. */
  WEB_DIST: z.string().optional(),
  /** Overrides the Drizzle migrations folder (Docker image). */
  MIGRATIONS_DIR: z.string().optional(),
  /** Login attempts per minute and instance (§5.5); the test suite raises it. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  MIGRATE_ON_START: bool.default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // SMTP (§4.16). Without SMTP_HOST, e-mails stay in the outbox and are logged in development.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Épicafé <no-reply@localhost>'),
  // Web Push. Without both keys, notifications are off. Generate with `npx web-push generate-vapid-keys`.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:no-reply@localhost'),
  /** Shared secret of the backup scripts, which report their result to the API (optional). */
  BACKUP_REPORT_TOKEN: z.string().min(16).optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${msg}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE doit valoir true en production (§5.5).');
  }
  return parsed.data;
}
