import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_KINDS,
  FEEDBACK_MODULES,
  FEEDBACK_PRIORITIES,
  FEEDBACK_PRIORITY_LABELS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUSES,
  feedbackModuleLabel,
  hasAnyRole,
  type FeedbackDetail,
  type FeedbackPriority,
  type FeedbackRow,
  type FeedbackStatus,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, Table } from '@/components/ui/card';
import { NoMatchRow, SortTh, useSort } from '@/components/ui/sortable';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';
import { FeedbackDialog } from './new-dialog';

const STATUS_VARIANT: Record<FeedbackStatus, 'default' | 'muted' | 'success' | 'destructive'> = {
  NEW: 'destructive',
  ACCEPTED: 'default',
  IN_PROGRESS: 'default',
  TO_TEST: 'default',
  DONE: 'success',
  REFUSED: 'muted',
  DUPLICATE: 'muted',
};

export function StatusBadge({ status }: { status: FeedbackStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{FEEDBACK_STATUS_LABELS[status]}</Badge>;
}

const SORT = {
  number: (r: FeedbackRow) => r.number,
  title: (r: FeedbackRow) => r.title,
  kind: (r: FeedbackRow) => FEEDBACK_KIND_LABELS[r.kind],
  module: (r: FeedbackRow) => feedbackModuleLabel(r.module),
  author: (r: FeedbackRow) => r.authorName,
  status: (r: FeedbackRow) => FEEDBACK_STATUS_LABELS[r.status],
  priority: (r: FeedbackRow) => FEEDBACK_PRIORITY_LABELS[r.priority],
  at: (r: FeedbackRow) => r.createdAt,
};

/** « Mes signalements »: what the person reported, and where it stands. */
export function MyFeedbackPage() {
  const [open, setOpen] = useState(false);
  const me = useMe();
  const { data, error, isPending } = useQuery({
    queryKey: ['feedback', 'mine'],
    queryFn: () => api.get<FeedbackRow[]>('/feedback/mine'),
  });
  const sort = useSort(data, SORT);
  return (
    <>
      <PageHeader
        title="Signalements"
        description="Un problème, une idée ? Dites-le, l’équipe vous répond ici et par courriel."
        actions={
          <div className="flex gap-2">
            {hasAnyRole(me.roles, ['ADMIN']) ? (
              <Link
                to="/signalements/gestion"
                className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent"
              >
                Gestion
              </Link>
            ) : null}
            <Button onClick={() => setOpen(true)}>Nouveau signalement</Button>
          </div>
        }
      />
      <FeedbackDialog open={open} onClose={() => setOpen(false)} />
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="number">
                N°
              </SortTh>
              <SortTh state={sort} sortKey="title">
                Titre
              </SortTh>
              <SortTh state={sort} sortKey="kind">
                Type
              </SortTh>
              <SortTh state={sort} sortKey="module">
                Module
              </SortTh>
              <SortTh state={sort} sortKey="status">
                État
              </SortTh>
              <SortTh state={sort} sortKey="at">
                Date
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {isPending ? (
              <tr>
                <td colSpan={6} className="text-muted-foreground">
                  Chargement…
                </td>
              </tr>
            ) : (data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted-foreground">
                  Vous n’avez rien signalé pour l’instant.
                </td>
              </tr>
            ) : (
              (sort.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{r.number}</td>
                  <td>
                    <Link
                      to="/signalements/$id"
                      params={{ id: r.id }}
                      className="text-primary hover:underline"
                    >
                      {r.title}
                    </Link>
                  </td>
                  <td>{FEEDBACK_KIND_LABELS[r.kind]}</td>
                  <td>{feedbackModuleLabel(r.module)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
          <NoMatchRow state={sort} total={data?.length} colSpan={6} />
        </Table>
      </Card>
    </>
  );
}

/** « Gestion »: every signalement, for the administrators. */
export function ManageFeedbackPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState('true');
  const [kind, setKind] = useState('');
  const [module, setModule] = useState('');
  const [q, setQ] = useState('');
  const params = new URLSearchParams({
    ...(open ? { open } : {}),
    ...(kind ? { kind } : {}),
    ...(module ? { module } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
  }).toString();
  const { data, error, isPending } = useQuery({
    queryKey: ['feedback', 'all', params],
    queryFn: () => api.get<FeedbackRow[]>(`/feedback?${params}`),
    placeholderData: (prev) => prev,
  });
  const change = useMutation({
    mutationFn: (v: { id: string; status?: FeedbackStatus; priority?: FeedbackPriority }) =>
      api.patch(`/feedback/${v.id}`, { status: v.status, priority: v.priority }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['feedback'] }),
  });
  const sort = useSort(data, SORT);
  return (
    <>
      <PageHeader
        title="Gestion des signalements"
        description="Les problèmes et idées signalés par les utilisateurs. Changer l’état prévient l’auteur par courriel."
        actions={
          <Link
            to="/signalements"
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent"
          >
            Mes signalements
          </Link>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Field label="Afficher">
          {(p) => (
            <Select {...p} value={open} onChange={(e) => setOpen(e.target.value)}>
              <option value="true">À traiter</option>
              <option value="false">Terminés</option>
              <option value="">Tous</option>
            </Select>
          )}
        </Field>
        <Field label="Type">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Tous</option>
              {FEEDBACK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FEEDBACK_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Module">
          {(p) => (
            <Select {...p} value={module} onChange={(e) => setModule(e.target.value)}>
              <option value="">Tous</option>
              {FEEDBACK_MODULES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Recherche">
          {(p) => (
            <Input
              {...p}
              value={q}
              placeholder="Titre, texte, SIG-0012"
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        </Field>
      </div>
      {error ? <QueryError error={error} /> : null}
      {change.error ? <Alert className="mb-3">{change.error.message}</Alert> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="number">
                N°
              </SortTh>
              <SortTh state={sort} sortKey="title">
                Titre
              </SortTh>
              <SortTh state={sort} sortKey="kind">
                Type
              </SortTh>
              <SortTh state={sort} sortKey="module">
                Module
              </SortTh>
              <SortTh state={sort} sortKey="author">
                Par
              </SortTh>
              <SortTh state={sort} sortKey="at">
                Date
              </SortTh>
              <SortTh state={sort} sortKey="status">
                État
              </SortTh>
              <SortTh state={sort} sortKey="priority">
                Priorité
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {isPending ? (
              <tr>
                <td colSpan={8} className="text-muted-foreground">
                  Chargement…
                </td>
              </tr>
            ) : (
              (sort.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{r.number}</td>
                  <td>
                    <Link
                      to="/signalements/$id"
                      params={{ id: r.id }}
                      className="text-primary hover:underline"
                    >
                      {r.title}
                    </Link>
                  </td>
                  <td>{FEEDBACK_KIND_LABELS[r.kind]}</td>
                  <td>{feedbackModuleLabel(r.module)}</td>
                  <td>{r.authorName ?? '—'}</td>
                  <td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                  <td>
                    <Select
                      aria-label={`État de ${r.number}`}
                      value={r.status}
                      onChange={(e) =>
                        change.mutate({ id: r.id, status: e.target.value as FeedbackStatus })
                      }
                    >
                      {FEEDBACK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {FEEDBACK_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Select
                      aria-label={`Priorité de ${r.number}`}
                      value={r.priority}
                      onChange={(e) =>
                        change.mutate({ id: r.id, priority: e.target.value as FeedbackPriority })
                      }
                    >
                      {FEEDBACK_PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {FEEDBACK_PRIORITY_LABELS[p]}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <NoMatchRow state={sort} total={data?.length} colSpan={8} />
        </Table>
      </Card>
    </>
  );
}

/** One signalement with its conversation. The author and the administrators see it. */
export function FeedbackDetailPage() {
  const { id } = useParams({ from: '/app/signalements/$id' });
  const me = useMe();
  const queryClient = useQueryClient();
  const isAdmin = hasAnyRole(me.roles, ['ADMIN']);
  const [reply, setReply] = useState('');
  const { data, error } = useQuery({
    queryKey: ['feedback', id],
    queryFn: () => api.get<FeedbackDetail>(`/feedback/${id}`),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['feedback'] });
  const send = useMutation({
    mutationFn: () => api.post(`/feedback/${id}/comments`, { body: reply }),
    onSuccess: () => {
      setReply('');
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: (v: { status?: FeedbackStatus; priority?: FeedbackPriority }) =>
      api.patch(`/feedback/${id}`, v),
    onSuccess: refresh,
  });
  if (error) return <QueryError error={error} />;
  if (!data) return <p className="text-muted-foreground">Chargement…</p>;
  return (
    <>
      <PageHeader
        title={`${data.number} — ${data.title}`}
        description={`${FEEDBACK_KIND_LABELS[data.kind]} · ${feedbackModuleLabel(data.module)}${data.screen ? ` · ${data.screen}` : ''}`}
        actions={
          <Link
            to={isAdmin ? '/signalements/gestion' : '/signalements'}
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent"
          >
            Retour à la liste
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="grid gap-4">
          <Card>
            <CardContent className="grid gap-4 pt-5 text-sm">
              <section>
                <h2 className="mb-1 font-medium">Description</h2>
                <p className="whitespace-pre-wrap">{data.description}</p>
              </section>
              {data.steps ? (
                <section>
                  <h2 className="mb-1 font-medium">Étapes pour reproduire</h2>
                  <p className="whitespace-pre-wrap">{data.steps}</p>
                </section>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-3 pt-5 text-sm">
              <h2 className="font-medium">Échanges</h2>
              {data.comments.length === 0 ? (
                <p className="text-muted-foreground">Aucun message pour l’instant.</p>
              ) : (
                data.comments.map((c) => (
                  <div
                    key={c.id}
                    className={`rounded-md border p-3 ${c.fromTeam ? 'bg-primary/5' : ''}`}
                  >
                    <p className="mb-1 text-xs text-muted-foreground">
                      {c.authorName ?? 'Quelqu’un'}
                      {c.fromTeam ? ' (équipe)' : ''} · {formatDateTime(c.createdAt)}
                    </p>
                    <p className="whitespace-pre-wrap">{c.body}</p>
                  </div>
                ))
              )}
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reply.trim()) send.mutate();
                }}
              >
                <Field label="Votre message">
                  {(p) => (
                    <Textarea
                      {...p}
                      rows={3}
                      value={reply}
                      maxLength={2000}
                      onChange={(e) => setReply(e.target.value)}
                    />
                  )}
                </Field>
                {send.error ? <Alert>{send.error.message}</Alert> : null}
                <div>
                  <Button type="submit" disabled={send.isPending || !reply.trim()}>
                    Envoyer
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
        <Card className="h-fit">
          <CardContent className="grid gap-3 pt-5 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">État</p>
              {isAdmin ? (
                <Select
                  aria-label="État"
                  value={data.status}
                  onChange={(e) => change.mutate({ status: e.target.value as FeedbackStatus })}
                >
                  {FEEDBACK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {FEEDBACK_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              ) : (
                <StatusBadge status={data.status} />
              )}
            </div>
            {isAdmin ? (
              <div>
                <p className="text-xs text-muted-foreground">Priorité</p>
                <Select
                  aria-label="Priorité"
                  value={data.priority}
                  onChange={(e) => change.mutate({ priority: e.target.value as FeedbackPriority })}
                >
                  {FEEDBACK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {FEEDBACK_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {change.error ? <Alert>{change.error.message}</Alert> : null}
            <div>
              <p className="text-xs text-muted-foreground">Signalé par</p>
              <p>{data.authorName ?? 'Compte supprimé'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Le</p>
              <p>{formatDateTime(data.createdAt)}</p>
            </div>
            {data.closedAt ? (
              <div>
                <p className="text-xs text-muted-foreground">Clos le</p>
                <p>{formatDateTime(data.closedAt)}</p>
              </div>
            ) : null}
            {isAdmin && data.context.page ? (
              <div>
                <p className="text-xs text-muted-foreground">Page au moment du signalement</p>
                <p className="break-all">{data.context.page}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {data.context.viewport} · {data.context.userAgent}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
