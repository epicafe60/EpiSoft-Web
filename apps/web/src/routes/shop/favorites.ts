import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const KEY = ['shop-favorites'];

/** The member's favourite product ids, with an optimistic toggle. */
export function useFavorites() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => api.get<string[]>('/shop/favorites') });
  const ids = new Set(data ?? []);
  const toggle = useMutation({
    mutationFn: (v: { id: string; on: boolean }) =>
      v.on ? api.put(`/shop/favorites/${v.id}`, {}) : api.delete(`/shop/favorites/${v.id}`),
    onMutate: async (v) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const before = queryClient.getQueryData<string[]>(KEY) ?? [];
      queryClient.setQueryData<string[]>(
        KEY,
        v.on ? [...new Set([...before, v.id])] : before.filter((x) => x !== v.id),
      );
      return { before };
    },
    onError: (_e, _v, ctx) => queryClient.setQueryData(KEY, ctx?.before ?? []),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
  return {
    has: (id: string) => ids.has(id),
    toggle: (id: string) => toggle.mutate({ id, on: !ids.has(id) }),
  };
}
