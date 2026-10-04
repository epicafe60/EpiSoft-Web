import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { filterRows, sortRows, type SortDir, type SortValue } from '@episoft/shared';
import { cn } from '@/lib/utils';

export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * Filters then sorts `rows`. A click on a header cycles ascending → descending → original order;
 * each column can also be searched from the box under its header (see SortTh). `accessors` maps
 * a column key to the value compared and searched; keep it stable (module constant) or in useMemo.
 */
export function useSort<T>(
  rows: readonly T[] | undefined,
  accessors: Record<string, (row: T) => SortValue>,
  initial: SortState | null = null,
) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const shown = useMemo(() => {
    if (!rows) return rows;
    const filtered = filterRows(rows, accessors, filters);
    const get = sort ? accessors[sort.key] : undefined;
    return sort && get ? sortRows(filtered, get, sort.dir) : filtered;
  }, [rows, sort, filters, accessors]);
  const toggle = (key: string) =>
    setSort((s) =>
      s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null,
    );
  const setFilter = (key: string, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const filtering = Object.values(filters).some((v) => v.trim());
  return {
    rows: shown,
    sort,
    toggle,
    filters,
    setFilter,
    filtering,
    clearFilters: () => setFilters({}),
  };
}

type SortApi = Pick<ReturnType<typeof useSort>, 'sort' | 'toggle' | 'filters' | 'setFilter'>;

/**
 * A column header that sorts the table when clicked (keyboard accessible, announced to screen
 * readers) and, under it, a search box for this column. Numbers accept ">10", "<=5", "=7".
 * Pass `filter={false}` for a column that makes no sense to search.
 */
export function SortTh({
  sortKey,
  state,
  className,
  children,
  filter = true,
  ...props
}: Omit<ComponentProps<'th'>, 'children'> & {
  sortKey: string;
  state: SortApi;
  filter?: boolean;
  children: ReactNode;
}) {
  const active = state.sort?.key === sortKey ? state.sort.dir : null;
  const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ChevronsUpDown;
  const right = className?.includes('text-right');
  return (
    <th
      {...props}
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
      className={className}
    >
      <button
        type="button"
        onClick={() => state.toggle(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 font-medium hover:text-foreground focus-visible:outline-2',
          right && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {children}
        <Icon className={cn('size-3.5', !active && 'opacity-40')} aria-hidden />
      </button>
      {filter ? (
        <input
          type="search"
          aria-label={`Filtrer la colonne ${typeof children === 'string' ? children : sortKey}`}
          placeholder="Filtrer"
          value={state.filters[sortKey] ?? ''}
          onChange={(e) => state.setFilter(sortKey, e.target.value)}
          className={cn(
            'mt-1 block w-full min-w-16 rounded border bg-background px-1.5 py-0.5 text-xs font-normal text-foreground placeholder:text-muted-foreground/60',
            right && 'text-right',
          )}
        />
      ) : null}
    </th>
  );
}

/** Placed in a <tfoot> under the table: tells the user when column filters hide every row. */
export function NoMatchRow({
  state,
  total,
  colSpan = 99,
}: {
  state: Pick<ReturnType<typeof useSort>, 'filtering' | 'rows' | 'clearFilters'>;
  total: number | undefined;
  colSpan?: number;
}) {
  if (!state.filtering || !total || (state.rows?.length ?? 0) > 0) return null;
  return (
    <tfoot>
      <tr>
        <td colSpan={colSpan} className="text-muted-foreground">
          Aucun résultat pour ces filtres.{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={state.clearFilters}
          >
            Effacer les filtres
          </button>
        </td>
      </tr>
    </tfoot>
  );
}
