import { useQuery } from '@tanstack/react-query';
import { DEFAULT_THRESHOLDS, type Thresholds } from '@episoft/shared';
import { api } from './api';

/**
 * The alert thresholds of the administration, for the screens that warn before a mistake.
 * The defaults apply while they load (or when the server cannot be reached).
 */
export function useThresholds(enabled = true): Thresholds {
  const { data } = useQuery({
    queryKey: ['thresholds'],
    queryFn: () => api.get<Thresholds>('/controls/thresholds'),
    enabled,
    staleTime: 5 * 60_000,
  });
  return data ?? DEFAULT_THRESHOLDS;
}
