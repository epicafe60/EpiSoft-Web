import { Link, Outlet } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatEuro } from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { TabNav } from '@/components/tab-nav';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert } from '@/components/ui/form';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';

const TABS = [
  { to: '/surveillance', label: 'Tickets à vérifier', exact: true },
  { to: '/surveillance/erreurs', label: 'Erreurs du serveur', adminOnly: true },
  { to: '/surveillance/courriels', label: 'Courriels' },
  { to: '/surveillance/sauvegardes', label: 'Sauvegardes' },
  { to: '/surveillance/activite', label: 'Derniers changements' },
] as const;

/** Everything that tells the responsables whether the application is doing well. */
export function MonitoringLayout() {
  const me = useMe();
  return (
    <>
      <PageHeader
        title="Surveillance"
        description="Ce qui mérite un coup d’œil : tickets refusés, erreurs, courriels, sauvegardes."
      />
      <TabNav label="Surveillance">
        {TABS.filter((t) => !('adminOnly' in t) || me.roles.includes('ADMIN')).map((t) => (
          <Link
            key={t.to}
            to={t.to}
            activeOptions={{ exact: 'exact' in t }}
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

function AllClear({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <CheckCircle2 className="size-4 text-success" /> {children}
    </p>
  );
}

// --- Refused tickets and tickets saved with a warning ----------------------------------------

interface Rejection {
  id: string;
  at: string;
  kind: string;
  reason: string;
  deviceName: string | null;
  payload: {
    total?: string;
    lines?: { label: string; qty: string; unitPrice: string }[];
  };
}

interface SaleWarning {
  id: string;
  number: string;
  soldAt: string;
  total: string;
  deviceName: string | null;
  warnings: { code: string; message: string }[];
}

export function ReviewPage() {
  const queryClient = useQueryClient();
  const rejections = useQuery({
    queryKey: ['rejections'],
    queryFn: () => api.get<Rejection[]>('/admin/rejections'),
  });
  const warnings = useQuery({
    queryKey: ['sale-warnings'],
    queryFn: () => api.get<SaleWarning[]>('/admin/sale-warnings'),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['rejections'] }),
      queryClient.invalidateQueries({ queryKey: ['sale-warnings'] }),
      queryClient.invalidateQueries({ queryKey: ['attention'] }),
    ]);
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/admin/rejections/${id}/ack`),
    onSuccess: refresh,
  });
  const review = useMutation({
    mutationFn: (id: string) => api.post(`/admin/sale-warnings/${id}/review`),
    onSuccess: refresh,
  });

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tickets refusés par le serveur</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            Un ticket refusé n’a modifié ni le stock ni la cagnotte. Le caissier le retrouve dans «
            Tickets du jour » pour le ressaisir. Classez-le ici une fois le cas réglé.
          </p>
          {rejections.error ? <QueryError error={rejections.error} /> : null}
          {rejections.data?.length === 0 ? <AllClear>Aucun ticket refusé.</AllClear> : null}
          {(rejections.data ?? []).map((r) => (
            <div key={r.id} className="grid gap-1 rounded-md border border-destructive/40 p-3">
              <p className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">Refusé</Badge>
                <span className="font-medium">{r.reason}</span>
              </p>
              <p className="text-muted-foreground">
                {formatDateTime(r.at)} · poste {r.deviceName ?? 'inconnu'} ·{' '}
                {r.kind === 'SALE' ? 'vente' : r.kind}
                {r.payload.total ? ` de ${formatEuro(r.payload.total)}` : ''}
              </p>
              {r.payload.lines?.length ? (
                <p className="text-muted-foreground">
                  {r.payload.lines.map((l) => `${l.qty} × ${l.label}`).join(', ')}
                </p>
              ) : null}
              <div>
                <Button size="sm" variant="outline" onClick={() => ack.mutate(r.id)}>
                  Classer
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tickets enregistrés avec un avertissement</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            Ces ventes sont bien enregistrées, mais quelque chose sortait de l’ordinaire (prix,
            quantité, remise, stock négatif, horloge du poste). Marquez-les comme vus après
            vérification.
          </p>
          {warnings.error ? <QueryError error={warnings.error} /> : null}
          {warnings.data?.length === 0 ? (
            <AllClear>Aucun avertissement à examiner.</AllClear>
          ) : null}
          {warnings.data?.length ? (
            <Table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Avertissements</th>
                  <th className="text-right">Total</th>
                  <th className="w-0" />
                </tr>
              </thead>
              <tbody>
                {warnings.data.map((w) => (
                  <tr key={w.id}>
                    <td>
                      {w.number}
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(w.soldAt)} · {w.deviceName ?? ''}
                      </span>
                    </td>
                    <td>
                      <ul className="grid gap-0.5">
                        {w.warnings.map((x, i) => (
                          <li key={i} className="flex gap-1">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                            {x.message}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="text-right tabular-nums">{formatEuro(w.total)}</td>
                    <td>
                      <Button size="sm" variant="outline" onClick={() => review.mutate(w.id)}>
                        Vu
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Unexpected errors -------------------------------------------------------------------------

interface ServerError {
  id: string;
  message: string;
  route: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
  lastRef: string;
  acknowledgedAt: string | null;
}

export function ErrorsPage() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['server-errors'],
    queryFn: () => api.get<ServerError[]>('/admin/errors'),
  });
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/admin/errors/${id}/ack`),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['server-errors'] }),
        queryClient.invalidateQueries({ queryKey: ['attention'] }),
      ]),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Erreurs inattendues du serveur</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          Quand un écran affiche « Référence ABC123 », cette référence retrouve l’erreur ici.
          Classez une erreur une fois traitée : si elle revient, elle réapparaît.
        </p>
        {error ? <QueryError error={error} /> : null}
        {data?.length === 0 ? <AllClear>Aucune erreur enregistrée.</AllClear> : null}
        {data?.length ? (
          <Table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Message</th>
                <th className="text-right">Fois</th>
                <th>Référence</th>
                <th className="w-0" />
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className={e.acknowledgedAt ? 'text-muted-foreground' : ''}>
                  <td>
                    {e.route}
                    <span className="block text-xs text-muted-foreground">
                      dernière : {formatDateTime(e.lastAt)}
                    </span>
                  </td>
                  <td className="max-w-md break-words">{e.message}</td>
                  <td className="text-right tabular-nums">{e.count}</td>
                  <td className="font-mono">{e.lastRef}</td>
                  <td>
                    {e.acknowledgedAt ? (
                      <Badge variant="muted">Classée</Badge>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => ack.mutate(e.id)}>
                        Classer
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- E-mails that did not leave ------------------------------------------------------------------

interface FailedEmail {
  id: string;
  to: string;
  subject: string;
  lastError: string | null;
  createdAt: string;
}

export function EmailsPage() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['failed-emails'],
    queryFn: () => api.get<FailedEmail[]>('/admin/emails/failed'),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.post(`/admin/emails/${id}/resend`),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['failed-emails'] }),
        queryClient.invalidateQueries({ queryKey: ['attention'] }),
      ]),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Courriels non envoyés</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          Le serveur de messagerie les a refusés après plusieurs essais. Vérifiez l’adresse du
          destinataire ou le réglage de la messagerie, puis renvoyez.
        </p>
        {error ? <QueryError error={error} /> : null}
        {data?.length === 0 ? <AllClear>Aucun courriel en échec.</AllClear> : null}
        {data?.length ? (
          <Table>
            <thead>
              <tr>
                <th>Destinataire</th>
                <th>Objet</th>
                <th>Erreur</th>
                <th className="w-0" />
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.to}
                    <span className="block text-xs text-muted-foreground">
                      {formatDateTime(m.createdAt)}
                    </span>
                  </td>
                  <td>{m.subject}</td>
                  <td className="text-destructive">{m.lastError}</td>
                  <td>
                    <Button size="sm" variant="outline" onClick={() => resend.mutate(m.id)}>
                      Renvoyer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- Backups -----------------------------------------------------------------------------------------

interface Backup {
  id: string;
  kind: 'BACKUP' | 'RESTORE_TEST';
  ok: boolean;
  sizeBytes: number | null;
  verified: boolean;
  offsite: boolean;
  detail: string | null;
  at: string;
}

const size = (n: number | null) => (n === null ? '—' : `${(n / 1_048_576).toFixed(1)} Mo`);

export function BackupsPage() {
  const { data, error } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<Backup[]>('/admin/backups'),
  });
  const lastGood = data?.find((b) => b.kind === 'BACKUP' && b.ok);
  const lastTest = data?.find((b) => b.kind === 'RESTORE_TEST' && b.ok);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sauvegardes de la base</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {error ? <QueryError error={error} /> : null}
        {data && !lastGood ? (
          <Alert>
            Aucune sauvegarde n’a été signalée à l’application. Vérifiez que la sauvegarde
            automatique est planifiée sur le serveur (voir le guide de maintenance).
          </Alert>
        ) : null}
        {lastGood ? (
          <p>
            Dernière sauvegarde réussie : <strong>{formatDateTime(lastGood.at)}</strong>
            {lastGood.verified ? ' (contrôlée)' : ' (non contrôlée)'}
            {lastGood.offsite ? ', copiée hors du serveur.' : ', non copiée hors du serveur.'}
          </p>
        ) : null}
        {data && !lastTest ? (
          <Alert variant="info">
            Aucun test de restauration n’a été signalé. Une sauvegarde qu’on n’a jamais restaurée
            n’est pas une certitude : lancez le test mensuel décrit dans le guide de maintenance.
          </Alert>
        ) : null}
        {data?.length ? (
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Résultat</th>
                <th className="text-right">Taille</th>
                <th>Détail</th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td>{formatDateTime(b.at)}</td>
                  <td>{b.kind === 'BACKUP' ? 'Sauvegarde' : 'Test de restauration'}</td>
                  <td>
                    <Badge variant={b.ok ? 'success' : 'destructive'}>
                      {b.ok ? 'Réussi' : 'Échec'}
                    </Badge>
                  </td>
                  <td className="text-right tabular-nums">{size(b.sizeBytes)}</td>
                  <td>{b.detail}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- What changed lately -------------------------------------------------------------------------------

interface Activity {
  id: string;
  at: string;
  actor: string;
  onBehalfOf: string | null;
  sentence: string;
}

export function ActivityPage() {
  const { data, error } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.get<Activity[]>('/admin/activity?limit=100'),
    refetchInterval: 60_000,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Derniers changements</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          Qui a fait quoi dans l’application, les plus récents d’abord. Le journal d’audit
          (Administration) garde le détail avant/après de chaque changement.
        </p>
        {error ? <QueryError error={error} /> : null}
        {data?.length === 0 ? <AllClear>Rien n’a encore été modifié.</AllClear> : null}
        {data?.length ? (
          <ul className="divide-y rounded-md border" aria-label="Derniers changements">
            {data.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-2">
                <span className="w-36 shrink-0 tabular-nums text-muted-foreground">
                  {formatDateTime(a.at)}
                </span>
                <span>
                  <strong>{a.actor}</strong>
                  {a.onBehalfOf ? ` (pour ${a.onBehalfOf})` : ''} {a.sentence}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
