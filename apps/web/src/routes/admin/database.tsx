import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import {
  LEGAL_RETENTIONS,
  RETENTION_CLASSES,
  retentionWarnings,
  type RetentionClass,
  type RetentionSettings,
  type Settings,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { formatBytes, growthPoints, parseDurationInput } from '@/lib/retention-ui';
import { formatDateTime } from '@/lib/utils';
import { confirmNow } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
} from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { QueryError } from '../errors';

// Administration › Base de données (ADR 0017): size, retention policy, purge, inactive members.

interface TableSize {
  name: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  rows: number;
  deadRows: number;
}
interface Summary {
  trigger: 'manual' | 'nightly';
  finishedAt: string;
  classes: { classId: string; label: string; cutoff: string; rows: number }[];
  total: number;
  bytesBefore: number;
  bytesAfter: number;
  archiveFile: string | null;
  truncated: boolean;
  error: string | null;
  anonymized?: number;
}
interface DatabaseInfo {
  bytes: number;
  tables: TableSize[];
  disk: { totalBytes: number; freeBytes: number; freePct: number } | null;
  snapshots: { at: string; totalBytes: number; reason: string }[];
  estimate: { rows: number; bytes: number };
  alerts: { dbSizeMb: number | null; diskFreePct: number | null };
  overThreshold: boolean;
  diskLow: boolean;
  vacuum: { table: string; deadRows: number; rows: number }[];
  lastPurge: Summary | null;
}
interface Preview {
  classes: { classId: string; label: string; cutoff: string | null; rows: number; bytes: number }[];
  totalRows: number;
  totalBytes: number;
  anonymization: { enabled: boolean; years: number; candidates: number; excluded: number };
}
interface PurgeStatus {
  running: boolean;
  trigger: string | null;
  current: string | null;
  rows: number;
  last: Summary | null;
}
interface InactiveRow {
  id: string;
  number: number;
  name: string;
  lastActivity: string;
  reasons?: string[];
}
interface Inactive {
  years: number;
  candidates: InactiveRow[];
  excluded: InactiveRow[];
}

const NATURE_LABEL = {
  LEGAL: 'Obligation légale',
  BUSINESS: 'Métier',
  TECHNICAL: 'Technique',
} as const;
const settingsQuery = { queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') };
const fr = (n: number) => n.toLocaleString('fr-FR');

export function DatabasePage() {
  return (
    <div className="grid gap-6">
      <SizeSection />
      <PolicySection />
      <PurgeSection />
      <InactiveSection />
      <ArchivesSection />
    </div>
  );
}

// --- Size ---------------------------------------------------------------------------------------

function SizeSection() {
  const { data, error, isPending } = useQuery({
    queryKey: ['db-info'],
    queryFn: () => api.get<DatabaseInfo>('/admin/database'),
  });
  if (error) return <QueryError error={error} />;
  if (isPending) return <p className="text-muted-foreground">Chargement…</p>;
  const top = data.tables.slice(0, 10);
  const biggest = Math.max(1, ...top.map((t) => t.totalBytes));
  const line = growthPoints(data.snapshots);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Taille de la base de données</CardTitle>
        <CardDescription>
          Relevée chaque semaine et après chaque purge. Les données utiles ne se purgent jamais ici
          : seuls les journaux, les courriels et les traces techniques sont concernés.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <div>
            <div className="text-3xl font-semibold tabular-nums">{formatBytes(data.bytes)}</div>
            <div className="text-sm text-muted-foreground">
              base de données
              {data.alerts.dbSizeMb !== null
                ? ` (alerte au-delà de ${fr(data.alerts.dbSizeMb)} Mo)`
                : ''}
            </div>
          </div>
          {data.disk ? (
            <div>
              <div className="text-3xl font-semibold tabular-nums">
                {data.disk.freePct.toFixed(0)} %
              </div>
              <div className="text-sm text-muted-foreground">
                d’espace libre sur le disque du serveur ({formatBytes(data.disk.freeBytes)})
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              L’espace libre du disque n’est pas lisible depuis ce serveur.
            </div>
          )}
          <div>
            <div className="text-3xl font-semibold tabular-nums">
              {formatBytes(data.estimate.bytes)}
            </div>
            <div className="text-sm text-muted-foreground">
              à gagner en purgeant maintenant ({fr(data.estimate.rows)} lignes, estimation)
            </div>
          </div>
        </div>
        {data.overThreshold ? (
          <Alert>
            La base dépasse le seuil d’alerte : regardez les plus gros consommateurs ci-dessous.
          </Alert>
        ) : null}
        {data.diskLow ? <Alert>Le disque du serveur manque de place.</Alert> : null}

        <div>
          <h3 className="mb-2 text-sm font-semibold">Les plus gros consommateurs</h3>
          <Table exportable={false}>
            <thead>
              <tr>
                <th>Table</th>
                <th className="text-right">Taille totale</th>
                <th className="text-right">dont index</th>
                <th className="text-right">Lignes</th>
                <th aria-hidden="true" className="w-1/3" />
              </tr>
            </thead>
            <tbody>
              {top.map((t) => (
                <tr key={t.name}>
                  <td className="font-mono text-xs">{t.name}</td>
                  <td className="text-right tabular-nums">{formatBytes(t.totalBytes)}</td>
                  <td className="text-right tabular-nums">{formatBytes(t.indexBytes)}</td>
                  <td className="text-right tabular-nums">{fr(t.rows)}</td>
                  <td aria-hidden="true">
                    <div
                      className="h-2 rounded bg-primary/60"
                      style={{ width: `${Math.max(2, (t.totalBytes / biggest) * 100)}%` }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Évolution</h3>
          {line ? (
            <svg
              viewBox="0 0 600 140"
              className="h-36 w-full rounded border bg-card"
              role="img"
              aria-label={`Taille de la base, de ${formatBytes(data.snapshots[0]!.totalBytes)} à ${formatBytes(data.snapshots.at(-1)!.totalBytes)}`}
            >
              <polyline
                points={line}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-primary"
              />
            </svg>
          ) : (
            <p className="text-sm text-muted-foreground">
              Pas encore assez de relevés pour une courbe (un par semaine).
            </p>
          )}
          {data.snapshots.length ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {data.snapshots.length} relevé(s), le dernier le{' '}
              {formatDateTime(data.snapshots.at(-1)!.at)} :{' '}
              {formatBytes(data.snapshots.at(-1)!.totalBytes)}.
            </p>
          ) : null}
        </div>

        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">Après une grosse purge</p>
          <p className="text-muted-foreground">
            PostgreSQL réutilise la place libérée pour les nouvelles données, mais ne rend pas le
            disque au système. Pour réduire vraiment le fichier, un technicien peut lancer{' '}
            <code>VACUUM FULL</code> sur une table, à un moment calme : la table est verrouillée
            pendant ce temps. L’application ne le lance jamais d’elle-même (voir la page
            Maintenance).
          </p>
          {data.vacuum.length ? (
            <p className="mt-1">
              Tables avec beaucoup de place libérable :{' '}
              {data.vacuum.map((v) => `${v.table} (${fr(v.deadRows)} lignes mortes)`).join(', ')}.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Policy -------------------------------------------------------------------------------------

function unitLabel(c: RetentionClass) {
  return c.unit === 'days' ? 'jours' : 'mois';
}

function PolicySection() {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery(settingsQuery);
  const initial = data?.['data.retention'];
  const [value, setValue] = useState<RetentionSettings | null>(null);
  // What is typed in the duration boxes (a draft, so that « 1 » can become « 12 »).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!initial) return;
    setValue(initial);
    setDrafts(
      Object.fromEntries(
        RETENTION_CLASSES.map((c) => [
          c.id,
          String((initial.durations as Record<string, number | null>)[c.id] ?? ''),
        ]),
      ),
    );
  }, [initial]);
  const save = useMutation({
    mutationFn: (v: RetentionSettings) => api.put<RetentionSettings>('/settings/data.retention', v),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: ['retention-preview'] });
      await queryClient.invalidateQueries({ queryKey: ['db-info'] });
    },
  });
  if (error) return <QueryError error={error} />;
  if (isPending || !value || !initial) return null;
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const invalid = RETENTION_CLASSES.some(
    (c) => parseDurationInput(drafts[c.id] ?? '') === 'invalid',
  );
  const current: RetentionSettings = {
    ...value,
    durations: {
      ...value.durations,
      ...Object.fromEntries(
        RETENTION_CLASSES.map((c) => {
          const p = parseDurationInput(drafts[c.id] ?? '');
          return [c.id, p === 'invalid' ? null : p];
        }),
      ),
    },
  };
  const warnings = Object.fromEntries(retentionWarnings(current).map((w) => [w.id, w.message]));
  const dirty = JSON.stringify(current) !== JSON.stringify(initial);
  const set = (patch: Partial<RetentionSettings>) => setValue({ ...value, ...patch });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conservation des données</CardTitle>
        <CardDescription>
          Combien de temps l’application garde chaque type de données avant de pouvoir les purger.
          Laissez vide pour ne jamais purger. Un minimum légal ne peut pas être descendu.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div>
          <h3 className="mb-1 text-sm font-semibold">Obligations légales (jamais purgées)</h3>
          <Table exportable={false}>
            <thead>
              <tr>
                <th>Données</th>
                <th>Durée minimale</th>
                <th>Règle</th>
              </tr>
            </thead>
            <tbody>
              {LEGAL_RETENTIONS.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td className="whitespace-nowrap">{l.months / 12} ans</td>
                  <td className="text-xs text-muted-foreground">{l.rule}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>

        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(current);
          }}
        >
          <div className="grid gap-3">
            {RETENTION_CLASSES.map((c) => {
              const err =
                errors[`durations.${c.id}`] ??
                (parseDurationInput(drafts[c.id] ?? '') === 'invalid'
                  ? 'Nombre entier d’au moins 1, ou vide.'
                  : undefined);
              return (
                <div
                  key={c.id}
                  className="grid gap-1 rounded-md border p-3 sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.label}</span>
                      <Badge variant={c.nature === 'TECHNICAL' ? 'muted' : 'default'}>
                        {NATURE_LABEL[c.nature]}
                      </Badge>
                      {c.floor?.legal ? <Badge variant="success">Minimum légal</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{c.scope}</p>
                    <p className="text-xs text-muted-foreground">Conservé : {c.keeps}</p>
                    {c.floor ? (
                      <p className="text-xs text-muted-foreground">
                        Minimum : {c.floor.value} {unitLabel(c)}. {c.floor.rule}
                      </p>
                    ) : null}
                    {warnings[c.id] ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        {warnings[c.id]}
                      </p>
                    ) : null}
                  </div>
                  <Field label={`Durée (${unitLabel(c)})`} error={err}>
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="numeric"
                        className="w-28"
                        placeholder="Toujours"
                        value={drafts[c.id] ?? ''}
                        onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="ret-nightly"
                checked={value.nightly}
                onChange={(e) => set({ nightly: e.target.checked })}
              />
              <Label htmlFor="ret-nightly">
                Purger automatiquement chaque nuit (entre 2 h et 5 h)
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="ret-archive"
                checked={value.archiveBeforePurge}
                onChange={(e) => set({ archiveBeforePurge: e.target.checked })}
              />
              <Label htmlFor="ret-archive">
                Garder une copie compressée de ce qui est purgé (téléchargeable 30 jours)
              </Label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                id="ret-anon"
                checked={value.anonymization.enabled}
                onChange={(e) =>
                  set({ anonymization: { ...value.anonymization, enabled: e.target.checked } })
                }
              />
              <Label htmlFor="ret-anon">Anonymiser chaque nuit les adhérents inactifs depuis</Label>
              <Input
                aria-label="Années d’inactivité"
                className="w-20"
                inputMode="numeric"
                value={String(value.anonymization.years)}
                onChange={(e) =>
                  set({
                    anonymization: {
                      ...value.anonymization,
                      years: Number(e.target.value.replace(/\D/g, '')) || 0,
                    },
                  })
                }
              />
              <span className="text-sm">an(s)</span>
              {errors['anonymization.years'] ? (
                <span className="text-sm text-destructive">{errors['anonymization.years']}</span>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Alerte si la base dépasse (Mo)"
                error={errors['alerts.dbSizeMb']}
                hint="Vide : pas d’alerte."
              >
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    value={value.alerts.dbSizeMb === null ? '' : String(value.alerts.dbSizeMb)}
                    onChange={(e) =>
                      set({
                        alerts: {
                          ...value.alerts,
                          dbSizeMb:
                            e.target.value === ''
                              ? null
                              : Number(e.target.value.replace(/\D/g, '')),
                        },
                      })
                    }
                  />
                )}
              </Field>
              <Field
                label="Alerte si l’espace libre passe sous (%)"
                error={errors['alerts.diskFreePct']}
                hint="Vide : pas d’alerte."
              >
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    value={
                      value.alerts.diskFreePct === null ? '' : String(value.alerts.diskFreePct)
                    }
                    onChange={(e) =>
                      set({
                        alerts: {
                          ...value.alerts,
                          diskFreePct:
                            e.target.value === ''
                              ? null
                              : Number(e.target.value.replace(/\D/g, '')),
                        },
                      })
                    }
                  />
                )}
              </Field>
            </div>
          </div>

          {save.isError && !Object.keys(errors).length ? <Alert>{save.error.message}</Alert> : null}
          {save.isError && Object.keys(errors).length ? (
            <Alert>Certaines durées sont sous un minimum : corrigez-les (en rouge).</Alert>
          ) : null}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!dirty || invalid || save.isPending}>
              Enregistrer
            </Button>
            {save.isSuccess && !dirty ? (
              <span role="status" className="text-sm text-success">
                Enregistré.
              </span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- Purge --------------------------------------------------------------------------------------

function PurgeSection() {
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ['retention-preview'],
    queryFn: () => api.get<Preview>('/admin/retention/preview'),
  });
  const [watch, setWatch] = useState(false);
  const status = useQuery({
    queryKey: ['retention-status'],
    queryFn: () => api.get<PurgeStatus>('/admin/retention/status'),
    refetchInterval: (q) => (watch || q.state.data?.running ? 1500 : false),
  });
  const running = status.data?.running ?? false;
  useEffect(() => {
    if (watch && status.data && !status.data.running) {
      setWatch(false);
      for (const k of ['retention-preview', 'db-info', 'retention-archives', 'retention-inactive'])
        void queryClient.invalidateQueries({ queryKey: [k] });
    }
  }, [watch, status.data, queryClient]);
  const [archive, setArchive] = useState(true);
  const start = useMutation({
    mutationFn: () => api.post('/admin/retention/purge', { confirm: true, archive }),
    onSuccess: () => {
      setWatch(true);
      void status.refetch();
    },
  });
  if (preview.error) return <QueryError error={preview.error} />;
  const p = preview.data;
  const last = status.data?.last;

  const run = async () => {
    if (!p) return;
    const ok = await confirmNow({
      title: 'Purger maintenant ?',
      message:
        'Les données plus anciennes que les durées choisies vont être supprimées définitivement. Les données légales ne sont jamais touchées.',
      impact: [
        `${fr(p.totalRows)} ligne(s), environ ${formatBytes(p.totalBytes)}`,
        archive
          ? 'Une copie compressée sera téléchargeable pendant 30 jours.'
          : 'Aucune copie ne sera gardée.',
        'L’opération est notée dans le journal d’audit et ne peut pas être annulée.',
      ],
      confirmLabel: 'Purger',
      destructive: true,
    });
    if (ok) start.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Purge</CardTitle>
        <CardDescription>
          Ce qu’une purge supprimerait maintenant, avec les durées enregistrées ci-dessus (aperçu :
          rien n’est supprimé tant que vous ne confirmez pas).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {p ? (
          <Table exportable={false}>
            <thead>
              <tr>
                <th>Type de données</th>
                <th>Avant le</th>
                <th className="text-right">Lignes</th>
                <th className="text-right">Taille</th>
              </tr>
            </thead>
            <tbody>
              {p.classes.map((c) => (
                <tr key={c.classId}>
                  <td>{c.label}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {c.cutoff ? formatDateTime(c.cutoff).split(' ')[0] : ''}
                  </td>
                  <td className="text-right tabular-nums">{fr(c.rows)}</td>
                  <td className="text-right tabular-nums">{formatBytes(c.bytes)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={2}>Total</td>
                <td className="text-right tabular-nums">{fr(p.totalRows)}</td>
                <td className="text-right tabular-nums">{formatBytes(p.totalBytes)}</td>
              </tr>
            </tbody>
          </Table>
        ) : (
          <p className="text-muted-foreground">Calcul de l’aperçu…</p>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="purge-archive"
              checked={archive}
              onChange={(e) => setArchive(e.target.checked)}
            />
            <Label htmlFor="purge-archive">Garder une copie compressée</Label>
          </div>
          <Button
            variant="destructive"
            disabled={!p || !p.totalRows || running || start.isPending}
            onClick={() => void run()}
          >
            <Trash2 /> Purger maintenant
          </Button>
          <Button
            variant="outline"
            onClick={() => void preview.refetch()}
            disabled={preview.isFetching}
          >
            Recalculer l’aperçu
          </Button>
        </div>
        {start.isError ? <Alert>{start.error.message}</Alert> : null}
        {running ? (
          <Alert variant="info">
            Purge en cours{status.data?.current ? ` : ${status.data.current}` : ''},{' '}
            {fr(status.data?.rows ?? 0)} ligne(s) supprimée(s)…
          </Alert>
        ) : null}
        {last && !running ? (
          <Alert variant={last.error ? 'error' : 'success'}>
            Dernière purge ({last.trigger === 'nightly' ? 'de nuit' : 'manuelle'},{' '}
            {formatDateTime(last.finishedAt)}) : {fr(last.total)} ligne(s), base de{' '}
            {formatBytes(last.bytesBefore)} à {formatBytes(last.bytesAfter)}.
            {last.truncated
              ? ' Le temps imparti est épuisé : le reste sera purgé à la prochaine fois.'
              : ''}
            {last.error ? ` Erreur : ${last.error}` : ''}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- Inactive members ---------------------------------------------------------------------------

function InactiveSection() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['retention-inactive'],
    queryFn: () => api.get<Inactive>('/admin/retention/inactive-members'),
  });
  const run = useMutation({
    mutationFn: () =>
      api.post<{ anonymized: number }>('/admin/retention/anonymize', { confirm: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['retention-inactive'] }),
  });
  if (error) return <QueryError error={error} />;
  if (!data) return null;
  const go = async () => {
    const ok = await confirmNow({
      title: 'Anonymiser les adhérents inactifs ?',
      message:
        'Nom, adresse, courriel, téléphone et identifiants sont effacés. Les montants restent pour la comptabilité. C’est définitif (RGPD).',
      impact: [`${data.candidates.length} adhérent(s) anonymisé(s)`],
      confirmLabel: 'Anonymiser',
      destructive: true,
    });
    if (ok) run.mutate();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Adhérents inactifs</CardTitle>
        <CardDescription>
          Sans aucune activité depuis {data.years} an(s) (connexion, achat, cagnotte, paiement,
          adhésion, précommande). Un adhérent avec une cagnotte non nulle, un rôle, une précommande
          ou un signalement ouvert n’est jamais anonymisé.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <span>
            <strong>{data.candidates.length}</strong> à anonymiser,{' '}
            <strong>{data.excluded.length}</strong> exclu(s).
          </span>
          <Button
            variant="destructive"
            disabled={!data.candidates.length || run.isPending}
            onClick={() => void go()}
          >
            Anonymiser maintenant
          </Button>
          {run.isSuccess ? (
            <span role="status" className="text-sm text-success">
              {run.data.anonymized} adhérent(s) anonymisé(s).
            </span>
          ) : null}
        </div>
        {run.isError ? <Alert>{run.error.message}</Alert> : null}
        {data.candidates.length || data.excluded.length ? (
          <Table exportable={false}>
            <thead>
              <tr>
                <th>N°</th>
                <th>Nom</th>
                <th>Dernière activité</th>
                <th>Décision</th>
              </tr>
            </thead>
            <tbody>
              {[...data.candidates, ...data.excluded].slice(0, 100).map((m) => (
                <tr key={m.id}>
                  <td className="tabular-nums">{m.number}</td>
                  <td>{m.name}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {formatDateTime(m.lastActivity).split(' ')[0]}
                  </td>
                  <td>
                    {m.reasons?.length ? (
                      <Badge variant="muted">Exclu : {m.reasons.join(', ')}</Badge>
                    ) : (
                      <Badge variant="destructive">À anonymiser</Badge>
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

// --- Archives -----------------------------------------------------------------------------------

function ArchivesSection() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['retention-archives'],
    queryFn: () =>
      api.get<{ keepDays: number; files: { name: string; bytes: number; at: string }[] }>(
        '/admin/retention/archives',
      ),
  });
  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/admin/retention/archives/${name}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['retention-archives'] }),
  });
  if (error) return <QueryError error={error} />;
  if (!data?.files.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Archives des purges</CardTitle>
        <CardDescription>
          Copies compressées de ce qui a été purgé (une ligne JSON par ligne supprimée). Elles
          contiennent des données personnelles : téléchargez-les pour les ranger en lieu sûr ; elles
          sont effacées du serveur après {data.keepDays} jours.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table exportable={false}>
          <thead>
            <tr>
              <th>Fichier</th>
              <th>Date</th>
              <th className="text-right">Taille</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.files.map((f) => (
              <tr key={f.name}>
                <td className="font-mono text-xs">{f.name}</td>
                <td className="whitespace-nowrap tabular-nums">{formatDateTime(f.at)}</td>
                <td className="text-right tabular-nums">{formatBytes(f.bytes)}</td>
                <td className="whitespace-nowrap text-right">
                  <a
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                    href={`/api/v1/admin/retention/archives/${f.name}`}
                  >
                    <Download className="size-4" /> Télécharger
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (
                        await confirmNow({
                          title: 'Supprimer cette archive ?',
                          message: 'Le fichier sera effacé du serveur.',
                          destructive: true,
                          confirmLabel: 'Supprimer',
                        })
                      )
                        del.mutate(f.name);
                    }}
                  >
                    Supprimer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardContent>
    </Card>
  );
}
