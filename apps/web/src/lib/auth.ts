import { queryOptions, useQuery } from '@tanstack/react-query';
import type { Me } from '@episoft/shared';
import { api, ApiError } from './api';

/** The connected user, or null when not logged in. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async (): Promise<Me | null> => {
    try {
      const me = await api.get<Me>('/me');
      writeCachedMe(me);
      return me;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        writeCachedMe(null);
        return null;
      }
      // Offline: the till keeps working with the last known user (R-OFF-03). The server
      // checks the session again when the operations are sent.
      if (e instanceof ApiError && e.status === 0) {
        const cached = readCachedMe();
        if (cached) return cached;
      }
      throw e;
    }
  },
  staleTime: 60_000,
});

const ME_KEY = 'episoft.me';

function readCachedMe(): Me | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

export function writeCachedMe(me: Me | null) {
  try {
    if (me) localStorage.setItem(ME_KEY, JSON.stringify(me));
    else localStorage.removeItem(ME_KEY);
  } catch {
    // Storage unavailable: no offline fallback, nothing else changes.
  }
}

export function useMe(): Me {
  const { data } = useQuery(meQuery);
  // Routes under the authenticated layout only render once `me` is loaded.
  if (!data) throw new Error('useMe() hors d’une page authentifiée');
  return data;
}
