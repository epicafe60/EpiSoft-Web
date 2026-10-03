import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/form';
import type { MemberListItem } from '@/lib/types';

/** Picks an existing household by searching one of its members (R-MBR-02). */
export function HouseholdPicker({
  value,
  onChange,
}: {
  value: { id: string; label: string } | null;
  onChange: (v: { id: string; label: string } | null) => void;
}) {
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const { data } = useQuery({
    queryKey: ['members', 'picker', query],
    queryFn: () => api.get<MemberListItem[]>(`/members?limit=10&q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
        <span>{value.label}</span>
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => onChange(null)}
        >
          Changer
        </button>
      </div>
    );
  }
  const households = new Map<string, MemberListItem[]>();
  for (const m of data ?? []) {
    if (!m.householdId) continue;
    households.set(m.householdId, [...(households.get(m.householdId) ?? []), m]);
  }
  return (
    <div className="grid gap-2">
      <Input
        type="search"
        placeholder="Nom d’un membre du foyer…"
        aria-label="Rechercher le foyer"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {households.size ? (
        <ul className="grid gap-1 rounded-md border p-1" role="listbox" aria-label="Foyers trouvés">
          {[...households.entries()].map(([id, ms]) => {
            const label = `Foyer n° ${ms[0]!.householdNumber} — ${ms.map((m) => `${m.firstName} ${m.lastName}`).join(', ')}`;
            return (
              <li key={id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => onChange({ id, label })}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
