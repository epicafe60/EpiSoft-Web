import { Link, Outlet } from '@tanstack/react-router';
import { TabNav } from '@/components/tab-nav';
import { Download } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '../shell';

const TABS = [
  { to: '/admin/parametres', label: 'Paramètres' },
  { to: '/admin/utilisateurs', label: 'Utilisateurs et rôles' },
  { to: '/admin/adhesions', label: 'Adhésions' },
  { to: '/admin/caisse', label: 'Caisse' },
  { to: '/admin/journal', label: 'Journal d’audit' },
  { to: '/admin/connexions', label: 'Connexions' },
  { to: '/admin/controles', label: 'Contrôles' },
] as const;

export function AdminLayout() {
  return (
    <>
      <PageHeader
        title="Administration"
        actions={
          <a className={buttonVariants({ variant: 'outline' })} href="/api/v1/admin/export.xlsx">
            <Download /> Exporter toute la base
          </a>
        }
      />
      <TabNav label="Administration">
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
