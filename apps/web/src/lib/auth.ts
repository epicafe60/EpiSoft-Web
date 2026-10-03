import { queryOptions, useQuery } from '@tanstack/react-query';
import type { Me } from '@episoft/shared';
import { api, ApiError } from './api';

/** The connected user, or null when not logged in. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await api.get<Me>('/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  staleTime: 60_000,
});

export function useMe(): Me {
  const { data } = useQuery(meQuery);
  // Routes under the authenticated layout only render once `me` is loaded.
  if (!data) throw new Error('useMe() hors d’une page authentifiée');
  return data;
}
