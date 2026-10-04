import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditEntry } from '@episoft/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, Table } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { QueryError } from '../errors';
import { AuditDiff } from './audit-diff';

const PAGE = 50;

const ACTION_LABELS: Record<string, string> = {
  'setting.update': 'Paramètre modifié',
  'member.roles': 'Rôles modifiés',
  'password.reset': 'Mot de passe défini',
  'password.link': 'Lien de mot de passe envoyé',
  'impersonate.start': 'Usurpation démarrée',
  'impersonate.stop': 'Usurpation terminée',
  'import.apply': 'Import appliqué',
  'export.full': 'Export complet de la base',
  'report.save': 'Rapport enregistré',
  'report.delete': 'Rapport supprimé',
  'review.moderate': 'Avis modéré',
  'preorder.status': 'État de précommande modifié',
};

/** R-ADM-02: filter by entity and period. */
export function AuditPage() {
  // ?membre=<id> (link from a member's page) narrows the journal to one person.
  const [memberId, setMemberId] = useState(
    () => new URLSearchParams(window.location.search).get('membre') ?? '',
  );
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
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
      {query.error ? <QueryError error={query.error} /> : null}
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
                </td>
                <td>{ACTION_LABELS[r.action] ?? r.action}</td>
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
