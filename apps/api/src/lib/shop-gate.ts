import type { Db } from '@episoft/db';
import { loadSettings } from '../modules/admin/settings-store';
import { forbidden } from './problem';

/**
 * Pre-handler of the customer-facing shop routes: refuses them while an administrator has
 * closed the online shop (Administration › Paramètres). Staff routes that handle the orders
 * already placed are not gated.
 */
export function shopOpen(db: Db) {
  return async () => {
    if (!(await loadSettings(db))['shop.enabled'].enabled)
      throw forbidden('La boutique en ligne est fermée pour le moment.');
  };
}
