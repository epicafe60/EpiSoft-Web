import type { DbOrTx } from '@episoft/db';
import { loadSettings } from '../admin/settings-store';

/** The association switched on the information of the consumer on food (Administration › Paramètres). */
export async function foodInfoEnabled(db: DbOrTx): Promise<boolean> {
  return (await loadSettings(db))['catalog.foodInfo'].enabled;
}
