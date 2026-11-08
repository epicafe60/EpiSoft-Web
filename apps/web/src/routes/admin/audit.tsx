import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { describeAudit, tableLabel, type AuditEntry, type RowChange } from '@episoft/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, Table } from '@/components/ui/card';
import { Alert, Field, Input } from '@/components/ui/form';
import { QueryError } from '../errors';
import { AuditDiff } from './audit-diff';
import { RevertDialog } from './revert-dialog';

const PAGE = 50;

/** Actions that are facts, not changes: no « Annuler » button. */
const FACTS = new Set([
  'auth.login',
  'auth.logout',
  'export.file',
  'export.full',
  'member.export',
  'member.export_all',
  'wallet.report_export',
  'backup.report',
  'staff.notified',
  'push.expired',
  'session.entry_failed',
  'sync.rejected',
]);

const OPS: Record<RowChange['op'], string> = { I: 'créé', U: 'modifié', D: 'supprimé' };

/** R-ADM-02: filter by entity and period. */
/**
 * R-SES-07: a till operation of a cashier sent through the session of someone else: whose session,
 * and whether the cashier typed their code.
 */
function CashierProof({ entry }: { entry: AuditEntry }) {
  const check = (entry.after as { cashierCheck?: string } | null)?.cashierCheck;
  if (!entry.viaSessionOfName && !check) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      {entry.viaSessionOfName ? `poste ouvert par ${entry.viaSessionOfName}` : null}
      {check === 'PIN' ? ' · code vérifié' : null}
      {check === 'DECLARED' ? (
        <span className="text-amber-700"> · caissier déclaré, non vérifié</span>
      ) : null}
    </span>
  );
}

export function AuditPage() {
  // ?membre=<id> (link from a member's page) narrows the journal to one person.
  const [memberId, setMemberId] = useState(
    () => new URLSearchParams(window.location.search).get('membre') ?? '',
  );
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [unattributed, setUnattributed] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const filters = { entity: entity.trim(), from, to, memberId };

  const query = useInfiniteQuery({
    queryKey: ['audit', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (filters.entity) params.set('entity', filters.entity);
      if (filters.memberId) params.set('memberId', filters.memberId);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (pageParam) params.set('cursor', pageParam);
      return api.get<AuditEntry[]>(`/audit?${params}`);
    },
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.id : undefined),
  });
  const rows = query.data?.pages.flat() ?? [];

  return (
    <div className="grid gap-4">
      {memberId ? (
        <p className="text-sm">
          Journal limité à une personne.{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setMemberId('')}
          >
            Tout afficher
          </button>
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3 lg:max-w-2xl">
        <Field label="Objet">
          {(p) => (
            <Input
              {...p}
              placeholder="member, setting…"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
            />
          )}
        </Field>
        <Field label="Du">
          {(p) => (
            <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          )}
        </Field>
        <Field label="Au">
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={unattributed}
          onChange={(e) => setUnattributed(e.target.checked)}
        />
        Modifications non attribuées (faites hors de l’application, ou sans action enregistrée)
      </label>
      {unattributed ? <Unattributed /> : null}
      {query.error ? <QueryError error={query.error} /> : null}
      <RevertDialog id={reverting} onClose={() => setReverting(null)} />
      <Card>
        <Table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Auteur</th>
              <th>Action</th>
              <th>Objet</th>
              <th>Changement</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="whitespace-nowrap tabular-nums">{formatDateTime(r.at)}</td>
                <td>
                  {r.actorName ?? <span className="text-muted-foreground">système</span>}
                  {r.onBehalfOfName ? (
                    <span className="block text-xs text-amber-700">
                      en tant que {r.onBehalfOfName}
                    </span>
                  ) : null}
                  <CashierProof entry={r} />
                </td>
                <td className="min-w-48">
                  {describeAudit(r.action, r.after)}
                  <span className="block text-xs text-muted-foreground">{r.action}</span>
                  {r.revertsId ? (
                    <span className="mt-1 inline-block rounded bg-muted px-1.5 text-xs">
                      annulation
                    </span>
                  ) : null}
                  {r.revertedBy ? (
                    <span className="mt-1 block rounded bg-warning/15 px-1.5 text-xs text-warning">
                      annulée le {formatDateTime(r.revertedBy.at)}
                      {r.revertedBy.actorName ? ` par ${r.revertedBy.actorName}` : ''}
                    </span>
                  ) : null}
                </td>
                <td className="text-xs">
                  {r.entity}
                  {r.entityId ? (
                    <span className="block max-w-40 truncate text-muted-foreground">
                      {r.entityId}
                    </span>
                  ) : null}
                </td>
                <td className="min-w-64">
                  <AuditDiff before={r.before} after={r.after} />
                  {r.detailed ? (
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0"
                        onClick={() => setDetails(details === r.id ? null : r.id)}
                      >
                        {details === r.id ? 'Masquer les données modifiées' : 'Données modifiées'}
                      </Button>
                      {!FACTS.has(r.action) && !r.revertedBy ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto px-0 text-destructive"
                          onClick={() => setReverting(r.id)}
                        >
                          Annuler…
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {details === r.id ? <Changes id={r.id} /> : null}
                </td>
              </tr>
            ))}
            {!query.isPending && rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucune entrée.
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          className="justify-self-center"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          Afficher plus
        </Button>
      ) : null}
    </div>
  );
}

/** « Données modifiées »: every row the action changed, as the database recorded it. */
function Changes({ id }: { id: string }) {
  const { data, error } = useQuery({
    queryKey: ['audit-changes', id],
    queryFn: () => api.get<(RowChange & { at: string })[]>(`/admin/audit/${id}/changes`),
  });
  if (error) return <Alert>{error.message}</Alert>;
  if (!data) return null;
  if (!data.length)
    return <p className="mt-1 text-xs text-muted-foreground">Aucune donnée modifiée.</p>;
  return (
    <ul className="mt-1 grid gap-1 text-xs" aria-label="Données modifiées">
      {data.map((c) => (
        <li key={c.id} className="rounded border p-1.5">
          <span className="font-medium">
            {tableLabel(c.table)} {OPS[c.op]}
          </span>
          <AuditDiff before={c.old} after={c.new} />
        </li>
      ))}
    </ul>
  );
}

interface UnattributedChange {
  xact: string;
  at: string;
  source: string | null;
  tables: string[];
  rows: number;
}

/** R-ADM-07: what changed without any action of the journal to explain it. */
function Unattributed() {
  const { data, error } = useQuery({
    queryKey: ['audit-unattributed'],
    queryFn: () => api.get<UnattributedChange[]>('/admin/audit/unattributed'),
  });
  if (error) return <QueryError error={error} />;
  if (!data) return null;
  if (!data.length)
    return (
      <Alert variant="success">
        Aucune modification non attribuée ces 30 derniers jours : tout est expliqué par le journal.
      </Alert>
    );
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Origine</th>
            <th>Données</th>
          </tr>
        </thead>
        <tbody>
          {data.map((u) => (
            <tr key={u.xact}>
              <td className="whitespace-nowrap tabular-nums">{formatDateTime(u.at)}</td>
              <td>
                {u.source ? 'application, sans action enregistrée' : 'directement dans la base'}
              </td>
              <td>
                {u.tables.map(tableLabel).join(', ')} ({u.rows} ligne{u.rows > 1 ? 's' : ''})
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
