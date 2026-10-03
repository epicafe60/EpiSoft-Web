import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (EpiSoft-Web). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Loads the git-ignored `.env` at the repository root, if present. Real env vars win. */
export function loadEnv(): void {
  const path = join(REPO_ROOT, '.env');
  if (existsSync(path)) config({ path, quiet: true });
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  return v;
}
