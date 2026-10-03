import { Link, Outlet } from '@tanstack/react-router';
import { PageHeader } from '../shell';

const TABS = [
  { to: '/appros/commandes', label: 'Commandes' },
  { to: '/appros/fournisseurs', label: 'Fournisseurs' },
  { to: '/appros/factures', label: 'Factures' },
  { to: '/appros/stock', label: 'Stock' },
  { to: '/appros/inventaires', label: 'Inventaires' },
] as const;

export function SuppliesLayout() {
  return (
    <>
      <PageHeader title="Approvisionnements" />
      <nav aria-label="Approvisionnements" className="mb-6 flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground [&.active]:border-primary [&.active]:text-foreground"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
