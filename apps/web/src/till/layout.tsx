import { Link, Outlet } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { DEFAULT_THRESHOLDS, tillHealth } from '@episoft/shared';
import { ArrowLeft, CloudOff, LogIn, RefreshCw, Wifi } from 'lucide-react';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { tillDb } from './db';
import { TillProvider, useTill } from './context';

/** R-OFF-05: permanent indicator — online or not, operations waiting, last synchronisation. */
function StatusIndicator() {
  const { sync, pendingCount, rejectedCount, meta, engine } = useTill();
  const online = sync.online;
  return (
    <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium',
          online ? 'bg-success/15 text-success' : 'bg-warning/20 text-warning',
        )}
      >
        {online ? <Wifi className="size-4" /> : <CloudOff className="size-4" />}
        {online ? 'En ligne' : 'Hors ligne'}
      </span>
      <span className={cn('tabular-nums', pendingCount ? 'font-medium' : 'text-muted-foreground')}>
        {pendingCount ? `${pendingCount} en attente d’envoi` : 'Tout est envoyé'}
      </span>
      {rejectedCount ? (
        <Link
          to="/caisse/tickets"
          className="font-medium text-destructive underline"
          title="Voir les tickets refusés"
        >
          {rejectedCount} refusé(s) : voir
        </Link>
      ) : null}
      <span className="hidden text-muted-foreground lg:inline">
        · synchro {meta.lastSnapshotAt ? formatDateTime(meta.lastSnapshotAt) : 'jamais'}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Synchroniser maintenant"
        onClick={() => {
          engine.kick();
          void engine.refresh();
        }}
      >
        <RefreshCw className={cn(sync.pushing && 'animate-spin')} />
      </Button>
    </div>
  );
}

function CashierName() {
  const { cashierId } = useTill();
  const me = useMe();
  const cashier = useLiveQuery(() => tillDb.members.get(cashierId), [cashierId]);
  const name = cashier
    ? `${cashier.firstName} ${cashier.lastName}`
    : `${me.firstName} ${me.lastName}`;
  return <span className="truncate">Caissier : {name}</span>;
}

/** What has been waiting too long: offline, old data, tickets not sent, a session left open. */
function HealthBanners() {
  const { meta, sync, settings } = useTill();
  const oldest = useLiveQuery(
    async () => (await tillDb.outbox.filter((o) => o.status === 'PENDING').sortBy('createdAt'))[0],
    [],
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const warnings = tillHealth(
    now,
    {
      online: sync.online,
      lastContactAt: meta.lastSnapshotAt,
      oldestPendingAt: oldest?.createdAt ?? null,
      sessionOpenedAt: meta.session?.openedAt ?? null,
    },
    settings?.thresholds ?? DEFAULT_THRESHOLDS,
  );
  if (!warnings.length) return null;
  return (
    <div role="status" className="grid gap-px bg-warning/30">
      {warnings.map((w) => (
        <p key={w.code} className="bg-warning/15 px-4 py-1.5 text-sm">
          {w.message}
        </p>
      ))}
    </div>
  );
}

function TillHeader() {
  const { meta, sync } = useTill();
  const tab =
    'rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent [&.active]:bg-primary/10 [&.active]:text-primary';
  return (
    <>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-card px-3 py-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          aria-label="Retour au back-office"
        >
          <ArrowLeft className="size-4" /> EpiSoft
        </Link>
        <span className="font-semibold">
          {meta.device ? `Caisse ${meta.device.name}` : 'Caisse'}
        </span>
        <nav aria-label="Caisse" className="flex gap-1">
          <Link to="/caisse" className={tab} activeOptions={{ exact: true }}>
            Vente
          </Link>
          <Link to="/caisse/tickets" className={tab}>
            Tickets du jour
          </Link>
          <Link to="/caisse/cloture" className={tab}>
            Clôture
          </Link>
        </nav>
        <span className="hidden min-w-0 flex-1 text-sm text-muted-foreground md:block">
          <CashierName />
        </span>
        <StatusIndicator />
        <Link
          to="/aide"
          className="text-sm text-muted-foreground underline hover:text-foreground"
          title="Que faire si…"
        >
          Aide
        </Link>
        <ThemeToggle />
      </header>
      <HealthBanners />
      {sync.authRequired ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 bg-warning/20 px-4 py-2 text-sm"
        >
          Votre connexion a expiré. Les ventes sont conservées sur ce poste ; reconnectez-vous pour
          les envoyer.
          <Link
            to="/connexion"
            search={{ redirect: '/caisse' }}
            className="inline-flex items-center gap-1 font-medium text-primary underline"
          >
            <LogIn className="size-4" /> Se reconnecter
          </Link>
        </div>
      ) : null}
    </>
  );
}

export function TillLayout() {
  return (
    <TillProvider>
      <div className="flex min-h-dvh flex-col">
        <TillHeader />
        <main id="contenu" className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </TillProvider>
  );
}
