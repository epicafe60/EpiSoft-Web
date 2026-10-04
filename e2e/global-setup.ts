import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { hash } from '@node-rs/argon2';
import { createDb, createPool, member, migrateAndSeed, REPO_ROOT, userRole } from '@episoft/db';
import { API_PORT, PREVIEW_PORT, WEB_PORT } from './playwright.config';
import { USERS } from './fixtures';
import { seedLot1 } from './seed';

function start(name: string, cwd: string, args: string[], env: Record<string, string>) {
  const child = spawn('pnpm', args, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
  });
  const log = (d: Buffer) => {
    if (process.env.E2E_DEBUG) process.stdout.write(`[${name}] ${d.toString()}`);
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);
  return child;
}

async function waitFor(url: string, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

/** Kills a process tree (pnpm → node) on Windows and POSIX. */
function kill(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else process.kill(-child.pid, 'SIGTERM');
}

export default async function globalSetup() {
  const container = await new PostgreSqlContainer('postgres:17').start();
  const url = container.getConnectionUri();
  const pool = createPool(url, 1);
  const db = createDb(pool);
  await migrateAndSeed(db);
  for (const u of Object.values(USERS)) {
    const [m] = await db
      .insert(member)
      .values({
        lastName: u.lastName,
        firstName: u.firstName,
        username: u.username,
        email: `${u.username.toLowerCase()}@example.org`,
        status: 'ACTIVE',
        passwordHash: await hash(u.password),
      })
      .returning();
    if (u.roles.length)
      await db.insert(userRole).values(u.roles.map((roleCode) => ({ memberId: m!.id, roleCode })));
  }
  await seedLot1(db);
  await pool.end();
  // Read by the tests to check the database (workers inherit the environment).
  process.env.E2E_DATABASE_URL = url;

  const api = start('api', join(REPO_ROOT, 'apps/api'), ['exec', 'tsx', 'src/server.ts'], {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    API_PORT: String(API_PORT),
    APP_URL: `http://localhost:${WEB_PORT}`,
    LOG_LEVEL: 'warn',
  });
  const web = start('web', join(REPO_ROOT, 'apps/web'), ['exec', 'vite'], {
    WEB_PORT: String(WEB_PORT),
    API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
  });
  // Production build served by `vite preview`: the only one with the service worker (R-OFF-01).
  const webEnv = {
    ...process.env,
    WEB_PORT: String(WEB_PORT),
    API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
  };
  const build = spawnSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: join(REPO_ROOT, 'apps/web'),
    env: webEnv,
    shell: true,
    stdio: 'pipe',
  });
  if (build.status !== 0) throw new Error(`vite build failed: ${build.stderr?.toString()}`);
  const preview = start(
    'preview',
    join(REPO_ROOT, 'apps/web'),
    ['exec', 'vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    {
      API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
    },
  );

  await waitFor(`http://127.0.0.1:${API_PORT}/api/v1/health`);
  await waitFor(`http://localhost:${WEB_PORT}/`);
  await waitFor(`http://localhost:${PREVIEW_PORT}/`);

  return async () => {
    kill(preview);
    kill(web);
    kill(api);
    await container.stop();
  };
}
