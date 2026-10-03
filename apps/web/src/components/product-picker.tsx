import { useDeferredValue, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { formatEuro } from '@episoft/shared';
import { api } from '@/lib/api';
import type { ProductListItem } from '@/lib/types';
import { Input } from './ui/form';

/**
 * Finds a product by name, code or barcode (a scanner types the code then Enter).
 * An exact code or EAN is chosen directly on Enter.
 */
export function ProductPicker({
  onPick,
  placeholder = 'Produit : nom, code ou code-barres…',
  autoFocus,
  supplierId,
}: {
  onPick: (p: ProductListItem) => void;
  placeholder?: string;
  autoFocus?: boolean;
  supplierId?: string;
}) {
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const { data } = useQuery({
    queryKey: ['products', 'picker', query],
    queryFn: () => api.get<ProductListItem[]>(`/products?limit=20&q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
  });
  const results = (data ?? []).filter((p) => p.kind === 'GOODS');
  const pick = (p: ProductListItem) => {
    onPick(p);
    setQ('');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (results.length === 1) pick(results[0]!);
  };
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={placeholder}
        placeholder={placeholder}
        className="pl-9"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
      />
      {query.length >= 2 && results.length ? (
        <ul
          className="absolute z-20 mt-1 grid max-h-72 w-full gap-0.5 overflow-y-auto rounded-md border bg-card p-1 shadow-lg"
          role="listbox"
          aria-label="Produits trouvés"
        >
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pick(p)}
                className="flex min-h-10 w-full items-center justify-between gap-2 rounded px-2 text-left text-sm hover:bg-accent"
              >
                <span>
                  <span className="text-muted-foreground">{p.code}</span> {p.name}
                  {supplierId && p.supplierName ? (
                    <span className="ml-1 text-xs text-muted-foreground">({p.supplierName})</span>
                  ) : null}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatEuro(p.salePrice)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
