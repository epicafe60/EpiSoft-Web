import { Link, Outlet } from '@tanstack/react-router';
import { TabNav } from '@/components/tab-nav';
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
      <TabNav label="Approvisionnements">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground [&.active]:border-primary [&.active]:text-foreground"
          >
            {t.label}
          </Link>
        ))}
      </TabNav>
      <Outlet />
    </>
  );
}
