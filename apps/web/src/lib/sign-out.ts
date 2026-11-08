import { confirmNow } from '@/components/confirm';
import { api, ApiError } from './api';
import { writeCachedMe } from './auth';
import { forgetPersonalData } from '@/till/db';

/**
 * What the browser keeps of the person who leaves: the offline cache of images, which may hold a
 * private document consulted before this version (audit KV2, S03), and the till's copy of the
 * members (S05; the sales not sent yet stay, see `forgetPersonalData`).
 */
async function forgetLocalCopies(): Promise<void> {
  try {
    if ('caches' in window) await caches.delete('episoft-media');
  } catch {
    // A browser without Cache Storage, or a private window: nothing was kept.
  }
  try {
    await forgetPersonalData();
  } catch {
    // No IndexedDB (private window): the till never stored anything.
  }
}

/**
 * Signs out on the server first. The session is closed only once the server said so: when the
 * request does not get through (no network, server down), the person is told and may try again,
 * instead of believing the session is closed while it is still valid (audit KV2, S06).
 * Returns false when the person chose to stay signed in.
 */
export async function signOut(): Promise<boolean> {
  for (;;) {
    try {
      await api.post('/auth/logout');
      break;
    } catch (e) {
      // Already signed out on the server: nothing left to close.
      if (e instanceof ApiError && e.status === 401) break;
      const retry = await confirmNow({
        title: 'Déconnexion impossible',
        message:
          'Le serveur n’a pas pu être joint : votre session est peut-être toujours ouverte. Vérifiez la connexion puis réessayez, surtout sur un poste partagé.',
        confirmLabel: 'Réessayer',
        cancelLabel: 'Rester connecté',
      });
      if (!retry) return false;
    }
  }
  writeCachedMe(null);
  await forgetLocalCopies();
  return true;
}
