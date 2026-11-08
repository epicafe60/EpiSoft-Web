import { Link, Outlet } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  EMAIL_STATUS_LABELS,
  EMAIL_STATUSES,
  formatEuro,
  type EmailDetail,
  type EmailLog,
  type EmailStatus,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { MailPreview } from '@/components/mail-preview';
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

// --- The journal of e-mails ----------------------------------------------------------------------

const EMAIL_BADGE: Record<EmailStatus, 'success' | 'muted' | 'destructive'> = {
  SENT: 'success',
  PENDING: 'muted',
  FAILED: 'destructive',
};
const EMAIL_PAGE = 50;
const EMAIL_FILTER_LABELS: Record<EmailStatus, string> = {
  SENT: 'Envoyés',
  PENDING: 'En attente',
  FAILED: 'Non envoyés',
};

/** Every e-mail the application wrote, whether it left or not (sending can be switched off). */
export function EmailsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<EmailStatus | ''>('');
  const [opened, setOpened] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['email-log', status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(EMAIL_PAGE) });
      if (status) params.set('status', status);
      if (pageParam) params.set('cursor', pageParam);
      return api.get<EmailLog>(`/admin/emails?${params}`);
    },
    getNextPageParam: (last) =>
      last.rows.length === EMAIL_PAGE ? last.rows[last.rows.length - 1]!.id : undefined,
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.post(`/admin/emails/${id}/resend`),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['email-log'] }),
        queryClient.invalidateQueries({ queryKey: ['attention'] }),
      ]),
  });
  const first = query.data?.pages[0];
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];
  const total = first ? first.counts.SENT + first.counts.PENDING + first.counts.FAILED : 0;
  const filters: { value: EmailStatus | ''; label: string; n: number }[] = [
    { value: '', label: 'Tous', n: total },
    ...EMAIL_STATUSES.map((s) => ({
      value: s,
      label: EMAIL_FILTER_LABELS[s],
      n: first?.counts[s] ?? 0,
    })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Journal des courriels</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {first && !first.sendingEnabled ? (
          <Alert variant="info">
            L’envoi des courriels est désactivé dans l’administration : ils sont enregistrés ici
            comme « Non envoyé » et ne partiront pas.
          </Alert>
        ) : null}
        <div role="group" aria-label="Filtrer par état" className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={status === f.value ? 'default' : 'outline'}
              aria-pressed={status === f.value}
              onClick={() => setStatus(f.value)}
            >
              {f.label} ({f.n})
            </Button>
          ))}
        </div>
        {query.error ? <QueryError error={query.error} /> : null}
        {query.data && rows.length === 0 ? (
          <AllClear>
            {status ? 'Aucun courriel dans cet état.' : 'Aucun courriel enregistré.'}
          </AllClear>
        ) : null}
        {rows.length ? (
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Destinataire</th>
                <th>Objet</th>
                <th>État</th>
                <th className="w-0" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="align-top">
                  <td className="whitespace-nowrap tabular-nums">{formatDateTime(m.createdAt)}</td>
                  <td>{m.to}</td>
                  <td>
                    <button
                      type="button"
                      className="text-left text-primary hover:underline"
                      onClick={() => setOpened(m.id)}
                    >
                      {m.subject}
                    </button>
                    {m.attachments.length ? (
                      <span className="block text-xs text-muted-foreground">
                        Pièce jointe : {m.attachments.join(', ')}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <Badge variant={EMAIL_BADGE[m.status]}>{EMAIL_STATUS_LABELS[m.status]}</Badge>
                    {m.status === 'SENT' && m.sentAt ? (
                      <span className="block text-xs text-muted-foreground">
                        le {formatDateTime(m.sentAt)}
                      </span>
                    ) : null}
                    {m.status === 'FAILED' && m.lastError ? (
                      <span className="block max-w-64 text-xs text-muted-foreground">
                        {m.lastError}
                      </span>
                    ) : null}
                    {m.status === 'PENDING' && m.attempts > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        {m.attempts} essai(s) déjà
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {m.status === 'FAILED' ? (
                      <Button size="sm" variant="outline" onClick={() => resend.mutate(m.id)}>
                        Renvoyer
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        <EmailPreviewDialog id={opened} onClose={() => setOpened(null)} />
        {query.hasNextPage ? (
          <Button
            variant="outline"
            className="justify-self-center"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            Afficher plus
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** « Aperçu » of one e-mail of the journal: header, body and attachments. */
function EmailPreviewDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, error } = useQuery({
    queryKey: ['email-detail', id],
    queryFn: () => api.get<EmailDetail>(`/admin/emails/${id}`),
    enabled: !!id,
    // Looking at a mail is recorded in the journal: no silent second look when the window opens again.
    gcTime: 0,
  });
  return (
    <Dialog open={!!id} onClose={onClose} title="Aperçu du courriel" className="max-w-2xl">
      {error ? <Alert>{error.message}</Alert> : null}
      {data ? (
        <MailPreview
          from={data.from}
          to={data.to}
          subject={data.subject}
          text={data.text ?? ''}
          html={data.html}
          attachments={data.files.map((f) => ({
            filename: f.filename,
            contentType: f.contentType,
            sizeBytes: f.sizeBytes,
            href: `/api/v1/admin/emails/${data.id}/attachments/${f.index}`,
          }))}
          note={`${EMAIL_STATUS_LABELS[data.status]}${
            data.sentAt ? ` le ${formatDateTime(data.sentAt)}` : ''
          } · écrit le ${formatDateTime(data.createdAt)}${
            data.status === 'FAILED' && data.lastError ? ` · ${data.lastError}` : ''
          } · l’expéditeur indiqué est celui du serveur aujourd’hui.`}
        />
      ) : error ? null : (
        <p className="text-muted-foreground">Chargement…</p>
      )}
    </Dialog>
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
  /** R-SES-07: a till operation sent through the session of this person. */
  viaSessionOf?: string | null;
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
                  {a.viaSessionOf ? (
                    <span className="text-muted-foreground"> · poste de {a.viaSessionOf}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
