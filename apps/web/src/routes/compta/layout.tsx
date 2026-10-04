import { Link, Outlet } from '@tanstack/react-router';
import { TabNav } from '@/components/tab-nav';
import { PageHeader } from '../shell';

const TABS = [
  { to: '/compta/ecritures', label: 'Écritures' },
  { to: '/compta/propositions', label: 'Propositions' },
  { to: '/compta/banque', label: 'Banque' },
  { to: '/compta/editions', label: 'Éditions' },
  { to: '/compta/budget', label: 'Budget' },
  { to: '/compta/plan', label: 'Plan comptable' },
  { to: '/compta/cloture', label: 'Clôture' },
] as const;

export function AccountingLayout() {
  return (
    <>
      <PageHeader title="Comptabilité" />
      <TabNav label="Comptabilité">
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
