import { inArray } from 'drizzle-orm';
import { setting, type DbOrTx } from '@episoft/db';
import {
  isSettingKey,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  settingSchemas,
  setAppTimeZone,
  type Settings,
} from '@episoft/shared';

/** Puts the time zone of the process back in line with the stored setting (start, save, undo). */
export async function refreshTimeZone(db: DbOrTx): Promise<void> {
  setAppTimeZone((await loadSettings(db))['app.timezone'].timeZone);
}

/** All settings, stored values over defaults. A stored value that no longer validates falls back. */
export async function loadSettings(db: DbOrTx): Promise<Settings> {
  const rows = await db.select().from(setting).where(inArray(setting.key, SETTING_KEYS));
  const result: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) {
    if (!isSettingKey(r.key)) continue;
    const parsed = settingSchemas[r.key].safeParse(r.value);
    if (parsed.success) result[r.key] = parsed.data;
  }
  return result as Settings;
}
