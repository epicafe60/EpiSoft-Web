import { Link, Outlet } from '@tanstack/react-router';
import { PageHeader } from '../shell';

const TABS = [
  { to: '/compta/ecritures', label: 'Écritures' },
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
      <nav aria-label="Comptabilité" className="mb-6 flex gap-1 overflow-x-auto border-b">
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
