import { useDeferredValue, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import {
  MEMBER_STATUS_LABELS,
  MEMBER_STATUSES,
  membershipState,
  type MemberStatus,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate, todayIso } from '@/lib/format';
import { buttonVariants } from '@/components/ui/button';
import { Badge, Card, Table } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import type { MemberListItem } from '@/lib/types';
import { PageHeader } from '../shell';
import { SortTh, useSort, NoMatchRow } from '@/components/ui/sortable';
import { QueryError } from '../errors';

export function MembershipBadge({ end }: { end: string | null }) {
  const state = membershipState(end, todayIso());
  if (state === 'VALID')
    return <Badge variant="success">Adhésion jusqu’au {formatDate(end)}</Badge>;
  if (state === 'EXPIRED')
    return <Badge variant="destructive">Adhésion expirée le {formatDate(end)}</Badge>;
  return <Badge variant="muted">Pas d’adhésion</Badge>;
}

const MEMBER_SORT = {
  number: (m: MemberListItem) => m.number,
  name: (m: MemberListItem) => `${m.lastName} ${m.firstName}`,
  contact: (m: MemberListItem) => m.email ?? m.phone,
  household: (m: MemberListItem) => m.householdNumber,
  balance: (m: MemberListItem) => (m.balance === null ? null : Number(m.balance)),
};

export function MembersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<MemberStatus | ''>('');
  const query = useDeferredValue(q.trim());
  const { data, error, isPending } = useQuery({
    queryKey: ['members', query, status],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '500' });
      if (query) p.set('q', query);
      if (status) p.set('status', status);
      return api.get<MemberListItem[]>(`/members?${p}`);
    },
    placeholderData: (prev) => prev,
  });

  const sort = useSort(data, MEMBER_SORT);

  return (
    <>
      <PageHeader
        title="Membres"
        description="Membres, foyers, adhésions et cagnottes."
        actions={
          <Link to="/membres/nouveau" className={buttonVariants()}>
            <Plus /> Nouveau membre
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Rechercher un membre"
            placeholder="Nom, n°, courriel, téléphone, badge…"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select
          aria-label="Statut"
          className="w-48"
          value={status}
          onChange={(e) => setStatus(e.target.value as MemberStatus | '')}
        >
          <option value="">Tous sauf archivés</option>
          {MEMBER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {MEMBER_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="number" className="w-16">
                N°
              </SortTh>
              <SortTh state={sort} sortKey="name">
                Membre
              </SortTh>
              <SortTh state={sort} sortKey="contact" className="hidden md:table-cell">
                Contact
              </SortTh>
              <SortTh state={sort} sortKey="household">
                Foyer
              </SortTh>
              <SortTh state={sort} sortKey="balance" className="text-right">
                Cagnotte
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {isPending ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Chargement…
                </td>
              </tr>
            ) : data?.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucun membre trouvé.
                </td>
              </tr>
            ) : (
              sort.rows?.map((m) => (
                <tr key={m.id}>
                  <td className="tabular-nums text-muted-foreground">{m.number}</td>
                  <td>
                    <Link
                      to="/membres/$id"
                      params={{ id: m.id }}
                      className="font-medium text-primary hover:underline"
                    >
                      {m.lastName} {m.firstName}
                    </Link>
                    {m.status !== 'ACTIVE' ? (
                      <Badge variant="muted" className="ml-2">
                        {MEMBER_STATUS_LABELS[m.status]}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="hidden text-muted-foreground md:table-cell">
                    <div className="max-w-56 truncate">{m.email}</div>
                    <div>{m.phone}</div>
                  </td>
                  <td>
                    {m.householdId ? (
                      <div className="grid justify-items-start gap-1">
                        <Link
                          to="/foyers/$id"
                          params={{ id: m.householdId }}
                          className="text-primary hover:underline"
                        >
                          Foyer n° {m.householdNumber}
                          {m.isReferent ? ' (référent)' : ''}
                        </Link>
                        <MembershipBadge end={m.membershipEnd} />
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td
                    className={`text-right tabular-nums ${m.balance?.startsWith('-') ? 'text-destructive' : ''}`}
                  >
                    {euro(m.balance)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <NoMatchRow state={sort} total={data?.length} />
        </Table>
      </Card>
    </>
  );
}
