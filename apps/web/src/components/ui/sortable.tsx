import { useMemo, useState, type ComponentProps } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { sortRows, type SortDir, type SortValue } from '@episoft/shared';
import { cn } from '@/lib/utils';

export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * Sorts `rows` by the column the user clicked. `accessors` maps a column key to the value to
 * compare; keep it stable (module constant) or wrapped in useMemo.
 */
export function useSort<T>(
  rows: readonly T[] | undefined,
  accessors: Record<string, (row: T) => SortValue>,
  initial: SortState | null = null,
) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const sorted = useMemo(() => {
    const get = sort ? accessors[sort.key] : undefined;
    return rows && sort && get ? sortRows(rows, get, sort.dir) : rows;
  }, [rows, sort, accessors]);
  const toggle = (key: string) =>
    setSort((s) =>
      s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  return { rows: sorted, sort, toggle };
}

/** A column header that sorts the table when clicked (keyboard accessible, announced to screen readers). */
export function SortTh({
  sortKey,
  state,
  className,
  children,
  ...props
}: ComponentProps<'th'> & {
  sortKey: string;
  state: { sort: SortState | null; toggle: (key: string) => void };
}) {
  const active = state.sort?.key === sortKey ? state.sort.dir : null;
  const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ChevronsUpDown;
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
          className?.includes('text-right') && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {children}
        <Icon className={cn('size-3.5', !active && 'opacity-40')} aria-hidden />
      </button>
    </th>
  );
}
