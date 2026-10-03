import { defineConfig } from 'drizzle-kit';
import { loadEnv } from './src/env';

loadEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  schemaFilter: ['app'],
  migrations: { schema: 'app', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
