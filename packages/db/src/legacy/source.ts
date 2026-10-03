import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

// Read-only access to the production EpiSoft MariaDB (CLAUDE.md golden rule).
// Settings come from EpiSoft.config, read the same way as tools/export_excel.py
// (and TPreferences.LoadConnectionParams). That file is never written.

export const DEFAULT_LEGACY_CONFIG = 'C:\\Datas\\Dev\\Episoft\\EpiSoft.config';

export function readLegacyConfig(path: string): Record<string, string> {
  const buf = readFileSync(path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  const cfg: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('/*') || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    cfg[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return cfg;
}

const asBool = (v: string | undefined) =>
  ['1', 'true', 'yes', 'oui', 'vrai'].includes((v ?? '').trim().toLowerCase());

export interface LegacySourceOptions {
  configPath: string;
  /** Overrides UseLocal from the config. */
  local?: boolean;
}

export interface LegacySource {
  description: string;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Only SELECT statements may be sent to the legacy database. */
function assertReadOnly(sql: string): void {
  if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) {
    throw new Error(`Requête refusée sur la base historique (SELECT seul) : ${sql.slice(0, 60)}`);
  }
}

export async function openLegacySource(opts: LegacySourceOptions): Promise<LegacySource> {
  const cfg = readLegacyConfig(opts.configPath);
  const useLocal = opts.local ?? asBool(cfg.UseLocal);
  const host = cfg[useLocal ? 'LHostName' : 'DHostName'];
  const port = Number(cfg[useLocal ? 'LPort' : 'DPort'] || 3306);
  const user = cfg.UserName;
  if (!host || !user) throw new Error('Paramètres de connexion introuvables dans EpiSoft.config');

  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password: cfg.Password ?? '',
    charset: 'utf8mb4',
    connectTimeout: 15_000,
    dateStrings: true,
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  // Belt and braces: the session itself refuses writes.
  await conn.query('SET SESSION TRANSACTION READ ONLY');

  return {
    description: `${useLocal ? 'locale' : 'distante'} ${host}:${port} (utilisateur ${user})`,
    async query<T>(sql: string, params: unknown[] = []) {
      assertReadOnly(sql);
      const [rows] = await conn.query(sql, params);
      return rows as T[];
    },
    close: () => conn.end(),
  };
}
