import { useState } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  BookOpen,
  Home,
  LogOut,
  Menu,
  Package,
  Settings,
  ShoppingBasket,
  ShoppingCart,
  Truck,
  Users,
  X,
  Store,
  type LucideIcon,
} from 'lucide-react';
import { visibleModules, type ModuleKey } from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe, writeCachedMe } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';

export const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  caisse: ShoppingCart,
  membres: Users,
  catalogue: Package,
  appros: Truck,
  precommandes: ShoppingBasket,
  compta: BookOpen,
  stats: BarChart3,
  admin: Settings,
};

/** Principle 1: one app, the menu shows only the user's modules (R-AUTH-05). */
function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe();
  const linkClass =
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground [&.active]:bg-primary/10 [&.active]:text-primary [&_svg]:size-4';
  return (
    <nav aria-label="Menu principal" className="grid gap-1">
      <Link to="/" className={linkClass} activeOptions={{ exact: true }} onClick={onNavigate}>
        <Home /> Accueil
      </Link>
      <Link to="/boutique" className={linkClass} onClick={onNavigate}>
        <Store /> Boutique
      </Link>
      {visibleModules(me.roles).map((m) => {
        const Icon = MODULE_ICONS[m.key];
        return (
          <Link key={m.key} to={m.path} className={linkClass} onClick={onNavigate}>
            <Icon /> {m.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Shown on every page while an administrator acts as another user. */
function ImpersonationBanner() {
  const me = useMe();
  if (!me.impersonator) return null;
  const stop = async () => {
    await api.post('/auth/impersonate/stop');
    writeCachedMe(null);
    // A full reload drops every cached screen of the impersonated user.
    window.location.assign('/admin/utilisateurs');
  };
  return (
    <div
      role="status"
      className="sticky top-2 z-30 mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-500 bg-amber-100 px-4 py-2 text-sm text-amber-950 shadow dark:bg-amber-950 dark:text-amber-100"
    >
      <span>
        Vous agissez en tant que{' '}
        <strong>
          {me.firstName} {me.lastName}
        </strong>{' '}
        ({me.roles.join(', ') || 'aucun rôle'}). Vos actions sont journalisées à votre nom.
      </span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={() => void stop()}>
        Revenir à mon compte
      </Button>
    </div>
  );
}

export function AppShell() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    writeCachedMe(null);
    queryClient.clear();
    await navigate({ to: '/connexion', search: {} });
  };

  const brand = (
    <Link to="/" className="flex items-center gap-2.5 px-2" onClick={() => setOpen(false)}>
      <img src="/favicon.svg" alt="" className="size-8" />
      <span className="leading-tight">
        <span className="block font-semibold">EpiSoft</span>
        <span className="block text-xs text-muted-foreground">Épicafé de Montjavoult</span>
      </span>
    </Link>
  );

  const userBox = (
    <div className="grid gap-2 border-t pt-3">
      <div className="px-2">
        <p className="truncate text-sm font-medium">
          {me.firstName} {me.lastName}
        </p>
        <p className="truncate text-xs text-muted-foreground">{me.username}</p>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" className="flex-1 justify-start" onClick={logout}>
          <LogOut /> Se déconnecter
        </Button>
        <ThemeToggle />
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-background focus:p-2"
      >
        Aller au contenu
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r bg-card p-3 lg:flex">
        {brand}
        <div className="flex-1 overflow-y-auto">
          <Nav />
        </div>
        {userBox}
      </aside>

      {/* Mobile and tablet header */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-card/95 px-3 backdrop-blur lg:hidden">
        {brand}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Ouvrir le menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <Menu />
        </Button>
      </header>
      {open ? (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-card p-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="px-2 font-semibold">Menu</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Fermer le menu"
                onClick={() => setOpen(false)}
              >
                <X />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <Nav onNavigate={() => setOpen(false)} />
            </div>
            {userBox}
          </div>
        </div>
      ) : null}

      <main id="contenu" className={cn('min-w-0 px-4 py-6 sm:px-6 lg:px-8')}>
        <div className="mx-auto max-w-6xl">
          <ImpersonationBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
