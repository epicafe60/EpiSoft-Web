import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_THRESHOLDS, tillHealth } from '@episoft/shared';
import { ArrowLeft, CloudOff, LogIn, RefreshCw, Wifi } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { getMeta, tillDb } from './db';
import { TillProvider, useTill } from './context';
import { CashierSwitchDialog, useCashierName, useCashierSwitchRequests } from './cashier-switch';

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

/**
 * R-VTE-01, R-SES-06 and R-SES-07: the cashier recorded on the tickets is the one keeping the till,
 * highlighted (the person signed in unless another was chosen). Touching a badge asks « Qui
 * encaisse ? »: the cashier changes without signing out. The other badges name the cashiers
 * connected lately.
 */
function ConnectedCashiers() {
  const me = useMe();
  const { sync, cashierId, settings } = useTill();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  useCashierSwitchRequests(show);
  const { data } = useQuery({
    queryKey: ['till-connected'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/pos/connected'),
    enabled: sync.online,
    refetchInterval: 30_000,
  });
  const activeName = useCashierName(cashierId);
  const active = {
    id: cashierId,
    name: cashierId === me.id ? `${me.firstName} ${me.lastName}` : (activeName ?? 'Caissier'),
  };
  const others = (data ?? []).filter((c) => c.id !== active.id);
  return (
    <>
      <ul className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Caissiers connectés">
        <li>
          <button
            type="button"
            onClick={show}
            className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground"
            title="Caissier : les ventes sont enregistrées à ce nom. Touchez pour changer de caissier."
          >
            {active.name}
            {cashierId !== me.id ? (
              <>
                {' '}
                <span className="opacity-80">
                  · poste de {me.firstName} {me.lastName}
                </span>
              </>
            ) : null}
          </button>
        </li>
        {others.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={show}
              className="rounded-full border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
              title="Connecté récemment. Touchez pour changer de caissier."
            >
              {c.name}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={show}
            className="rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Changer de caissier
          </button>
        </li>
      </ul>
      <CashierSwitchDialog
        open={open}
        onClose={() => setOpen(false)}
        online={sync.online}
        pinRequired={settings?.cashierPinRequired ?? true}
        activeId={cashierId}
      />
    </>
  );
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
  const { sync } = useTill();
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
        <span className="font-semibold">Caisse</span>
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
        <span className="min-w-0 flex-1">
          <ConnectedCashiers />
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
      {sync.deviceProblem === 'DEVICE_UNKNOWN' ? <DeviceUnknownBanner /> : null}
      {sync.deviceProblem === 'DEVICE_DISABLED' ? (
        <div role="alert" className="bg-warning/20 px-4 py-2 text-sm">
          Ce poste de caisse a été désactivé par un administrateur. Les ventes sont conservées sur
          ce poste ; demandez-lui de le réactiver (Administration › Caisse).
        </div>
      ) : null}
    </>
  );
}

/**
 * The server does not know this device (deleted, or the database was restored): nothing is lost,
 * the sales wait here. Declaring the device again lets them go.
 */
function DeviceUnknownBanner() {
  const { engine } = useTill();
  const [name, setName] = useState(() => '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    void getMeta('device').then((device) => setName((n) => n || device?.name || 'CAISSE1'));
  }, []);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await engine.redeclare(name);
    } catch (e) {
      setError(
        e instanceof Error && /porte déjà ce nom/.test(e.message)
          ? 'Un poste porte déjà ce nom sur le serveur : choisissez un autre nom (par exemple CAISSE2).'
          : e instanceof Error
            ? e.message
            : 'Enregistrement impossible.',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div role="alert" className="grid gap-2 bg-warning/20 px-4 py-2 text-sm">
      <p>
        Le serveur ne connaît plus ce poste de caisse. Les ventes sont conservées ici et seront
        envoyées dès que le poste sera redéclaré.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex items-center gap-2">
          Nom du poste
          <input
            className="h-8 rounded-md border border-input bg-background px-2 uppercase"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value.toUpperCase())}
          />
        </label>
        <Button type="submit" size="sm" disabled={pending || !name.trim()}>
          Redéclarer ce poste
        </Button>
        {error ? <span className="text-destructive">{error}</span> : null}
      </form>
    </div>
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
