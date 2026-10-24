import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Wrench } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '@/lib/api';
import { confirmNow, promptNow } from '@/components/confirm';
import { formatDateTime } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert } from '@/components/ui/form';
import { Badge, Card, CardContent } from '@/components/ui/card';
import { QueryError } from '../errors';
import { Dialog } from '@/components/ui/dialog';
import { ReportTableView, type ReportTableData } from '@/components/report-table';
import { useState } from 'react';

interface Sample {
  ref: string;
  detail: string;
  link: string | null;
}

interface Check {
  id: string;
  label: string;
  severity: 'error' | 'warning';
  count: number;
  samples: Sample[];
  help: { what: string; todo: string };
  analysis: boolean;
  list: { to: string; label: string } | null;
  fix: { label: string; confirm: string } | null;
  ackable: boolean;
  accepted: (Sample & { note: string | null })[];
}

interface Report {
  at: string;
  errors: number;
  warnings: number;
  checks: Check[];
}

/** In-app link to a path built by the API (always one of our pages), without a page reload. */
function Open({ to, children }: { to: string; children: string }) {
  const navigate = useNavigate();
  return (
    <a
      href={to}
      className="text-primary hover:underline"
      onClick={(e) => {
        e.preventDefault();
        // A query string (e.g. ?edition=…) is read from the address bar: load the page normally.
        if (to.includes('?')) window.location.assign(to);
        else void navigate({ to: to as never });
      }}
    >
      {children}
    </a>
  );
}

/**
 * Automated cross-checks of stock, cagnotte, tickets and accounting figures. Each case links to
 * the item to review; derived figures can be recomputed in one click, and a reviewed warning can
 * be accepted (it stays listed under "acceptés" and can be taken back).
 */
export function IntegrityPage() {
  const queryClient = useQueryClient();
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ['integrity'],
    queryFn: () => api.get<Report>('/admin/integrity'),
    staleTime: 0,
  });
  const done = () => queryClient.invalidateQueries({ queryKey: ['integrity'] });
  const fix = useMutation({
    mutationFn: (id: string) => api.post<{ fixed: number }>(`/admin/integrity/${id}/fix`),
    onSuccess: done,
  });
  const accept = useMutation({
    mutationFn: (v: { checkId: string; ref: string; note: string | null }) =>
      api.post('/admin/integrity/accept', {
        checkId: v.checkId,
        ref: v.ref,
        note: v.note ?? undefined,
      }),
    onSuccess: done,
  });
  const unaccept = useMutation({
    mutationFn: (v: { checkId: string; ref: string }) => api.post('/admin/integrity/unaccept', v),
    onSuccess: done,
  });
  const failure = fix.error ?? accept.error ?? unaccept.error;
  const [analysis, setAnalysis] = useState<Check | null>(null);
  const detail = useQuery({
    queryKey: ['integrity-analysis', analysis?.id],
    queryFn: () => api.get<ReportTableData>(`/admin/integrity/${analysis!.id}/analysis`),
    enabled: !!analysis,
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Chaque calcul est recoupé avec les écritures sources : stock, cagnotte, tickets,
          comptabilité. Les contrôles tournent aussi chaque nuit.
        </p>
        <Button
          variant="outline"
          className="ml-auto"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw /> Relancer les contrôles
        </Button>
      </div>
      <WalletReportCard />
      {error ? <QueryError error={error} /> : null}
      {failure ? <Alert>{failure.message}</Alert> : null}
      {fix.isSuccess ? (
        <Alert variant="success">{fix.data.fixed} élément(s) recalculé(s).</Alert>
      ) : null}
      {data ? (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={data.errors ? 'destructive' : 'success'}>
              {data.errors ? `${data.errors} anomalie(s) de calcul` : 'Aucune anomalie de calcul'}
            </Badge>
            <Badge variant="muted">{data.warnings} point(s) à revoir</Badge>
            <span className="text-muted-foreground">le {formatDateTime(data.at)}</span>
          </p>
          <ul className="grid gap-2" aria-label="Contrôles">
            {data.checks.map((c) => (
              <li key={c.id}>
                <Card>
                  <CardContent className="grid gap-2 pt-4 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          c.count === 0
                            ? 'success'
                            : c.severity === 'error'
                              ? 'destructive'
                              : 'muted'
                        }
                      >
                        {c.count === 0 ? 'OK' : c.severity === 'error' ? 'Anomalie' : 'À revoir'}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
                      <span className="font-medium">{c.label}</span>
                      {c.count ? <span className="ml-auto tabular-nums">{c.count}</span> : null}
                    </p>
                    <details>
                      <summary className="cursor-pointer text-xs text-primary">
                        Que contrôle-t-on ? Que faire ?
                      </summary>
                      <div className="mt-2 grid gap-2 rounded-md bg-muted/50 p-3 text-xs">
                        <p>
                          <strong>Contrôlé : </strong>
                          {c.help.what}
                        </p>
                        <p>
                          <strong>À faire : </strong>
                          {c.help.todo}
                        </p>
                      </div>
                    </details>
                    {c.count > 0 && (c.list || c.fix || c.analysis) ? (
                      <p className="flex flex-wrap items-center gap-3">
                        {c.analysis ? (
                          <Button size="sm" variant="outline" onClick={() => setAnalysis(c)}>
                            Analyse détaillée
                          </Button>
                        ) : null}
                        {c.list ? <Open to={c.list.to}>{`Ouvrir : ${c.list.label} →`}</Open> : null}
                        {c.fix ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={fix.isPending}
                            onClick={async () => {
                              if (
                                await confirmNow({
                                  title: c.fix!.label,
                                  message: c.fix!.confirm,
                                  confirmLabel: c.fix!.label,
                                })
                              )
                                fix.mutate(c.id);
                            }}
                          >
                            <Wrench /> {c.fix.label}
                          </Button>
                        ) : null}
                      </p>
                    ) : null}
                    {c.samples.length ? (
                      <details open={c.count <= 3}>
                        <summary className="cursor-pointer text-xs text-primary">
                          Voir les {Math.min(c.count, c.samples.length)} premiers cas
                        </summary>
                        <ul className="mt-2 grid gap-1.5 text-xs">
                          {c.samples.map((s, i) => (
                            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <strong>{s.ref}</strong> — {s.detail}
                              {s.link ? <Open to={s.link}>Ouvrir →</Open> : null}
                              {c.ackable ? (
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground hover:underline"
                                  onClick={async () => {
                                    const note = await promptNow({
                                      title: 'Accepter ce point',
                                      message:
                                        'Vous avez vérifié ce cas et vous l’acceptez tel quel : il ne sera plus signalé.',
                                      input: { label: 'Note (facultative)', minLength: 0 },
                                      confirmLabel: 'Accepter',
                                    });
                                    if (note !== null)
                                      accept.mutate({
                                        checkId: c.id,
                                        ref: s.ref,
                                        note: note.trim() || null,
                                      });
                                  }}
                                >
                                  Accepter
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {c.accepted.length ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          {c.accepted.length} point(s) accepté(s)
                        </summary>
                        <ul className="mt-2 grid gap-1.5 text-xs text-muted-foreground">
                          {c.accepted.map((s, i) => (
                            <li key={i} className="flex flex-wrap items-center gap-x-2">
                              <strong>{s.ref}</strong> — {s.detail}
                              {s.note ? <em>« {s.note} »</em> : null}
                              {s.link ? <Open to={s.link}>Ouvrir →</Open> : null}
                              <button
                                type="button"
                                className="hover:text-foreground hover:underline"
                                onClick={() => unaccept.mutate({ checkId: c.id, ref: s.ref })}
                              >
                                Remettre à revoir
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Dialog
        open={!!analysis}
        onClose={() => setAnalysis(null)}
        title={detail.data?.title ?? 'Analyse détaillée'}
        description={detail.data?.subtitle}
        className="max-w-6xl"
      >
        {detail.error ? <QueryError error={detail.error} /> : null}
        {detail.data ? (
          <div className="grid gap-3">
            <div className="max-h-[60vh] overflow-auto">
              <ReportTableView data={detail.data} busy={detail.isFetching} />
            </div>
            <a
              className="w-fit text-sm text-primary hover:underline"
              href={`/api/v1/admin/integrity/${analysis!.id}/analysis?format=xlsx`}
            >
              Exporter en Excel
            </a>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Chargement…</p>
        )}
      </Dialog>
    </div>
  );
}

/** R-EVO-50: the cagnotte of every household, rebuilt from its history, to hand to the board. */
function WalletReportCard() {
  const { data } = useQuery({
    queryKey: ['wallet-report'],
    queryFn: () =>
      api.get<{ households: number; green: number; negative: number; toCheck: number }>(
        '/admin/wallet-report',
      ),
  });
  if (!data) return null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 pt-4 text-sm">
        <span className="font-medium">Cagnottes par foyer</span>
        <Badge variant="success">{data.green} vert(s)</Badge>
        <Badge variant={data.toCheck ? 'destructive' : 'muted'}>{data.toCheck} à vérifier</Badge>
        <Badge variant={data.negative ? 'destructive' : 'muted'}>{data.negative} négatif(s)</Badge>
        <span className="text-muted-foreground">sur {data.households} foyers</span>
        <a
          className={buttonVariants({ variant: 'outline', className: 'ml-auto' })}
          href="/api/v1/admin/wallet-report.xlsx"
        >
          Rapport Excel
        </a>
      </CardContent>
    </Card>
  );
}
