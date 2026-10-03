import { Link, Outlet } from '@tanstack/react-router';
import { PageHeader } from '../shell';

const TABS = [
  { to: '/admin/parametres', label: 'Paramètres' },
  { to: '/admin/utilisateurs', label: 'Utilisateurs et rôles' },
  { to: '/admin/journal', label: 'Journal d’audit' },
  { to: '/admin/connexions', label: 'Connexions' },
] as const;

export function AdminLayout() {
  return (
    <>
      <PageHeader title="Administration" />
      <nav aria-label="Administration" className="mb-6 flex gap-1 overflow-x-auto border-b">
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
