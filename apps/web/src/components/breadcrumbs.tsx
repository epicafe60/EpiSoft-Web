import { Fragment } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

export interface Crumb {
  label: string;
  /** App path of the parent page; omit on the last item (the current page). */
  to?: string;
}

/**
 * Where we are, and the way back up: Section › List › This page. The last item is the current
 * page; the others are links. Placed at the top of form and detail pages.
 */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Fil d’Ariane" className="mb-3">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-muted-foreground">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={`${c.label}-${i}`}>
              <li className="min-w-0">
                {c.to && !last ? (
                  <Link to={c.to as never} className="hover:text-foreground hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current={last ? 'page' : undefined} className="text-foreground">
                    {c.label}
                  </span>
                )}
              </li>
              {!last ? (
                <li aria-hidden className="flex">
                  <ChevronRight className="size-3.5" />
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
