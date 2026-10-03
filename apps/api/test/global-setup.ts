import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { GlobalSetupContext } from 'vitest/node';
import { createDb, createPool, migrateAndSeed } from '@episoft/db';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** A throwaway PostgreSQL 17 with the real migrations applied (spec §7.2: Testcontainers). */
export default async function setup({ provide }: GlobalSetupContext) {
  container = await new PostgreSqlContainer('postgres:17').start();
  const url = container.getConnectionUri();
  const pool = createPool(url, 1);
  try {
    await migrateAndSeed(createDb(pool));
  } finally {
    await pool.end();
  }
  provide('databaseUrl', url);
  return async () => {
    await container?.stop();
  };
}
