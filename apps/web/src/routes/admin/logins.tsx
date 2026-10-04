import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Badge, Card, Table } from '@/components/ui/card';
import { NoMatchRow, SortTh, useSort } from '@/components/ui/sortable';
import { QueryError } from '../errors';

interface LoginRow {
  id: string;
  at: string;
  username: string | null;
  memberName: string | null;
  success: boolean;
  ip: string | null;
  device: string | null;
  logoutAt: string | null;
}

const LOGIN_SORT = {
  at: (r: LoginRow) => r.at,
  user: (r: LoginRow) => r.memberName ?? r.username,
  result: (r: LoginRow) => (r.success ? 'Réussie' : 'Échec'),
  logout: (r: LoginRow) => r.logoutAt,
  ip: (r: LoginRow) => r.ip,
  device: (r: LoginRow) => r.device,
};

/** R-AUTH-07: connection log, including failed attempts. */
export function LoginsPage() {
  const { data, error, isPending } = useQuery({
    queryKey: ['logins'],
    queryFn: () => api.get<LoginRow[]>('/admin/logins?limit=200'),
  });
  const sort = useSort(data, LOGIN_SORT);
  if (error) return <QueryError error={error} />;
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <SortTh state={sort} sortKey="at">
              Date
            </SortTh>
            <SortTh state={sort} sortKey="user">
              Utilisateur
            </SortTh>
            <SortTh state={sort} sortKey="result">
              Résultat
            </SortTh>
            <SortTh state={sort} sortKey="logout">
              Déconnexion
            </SortTh>
            <SortTh state={sort} sortKey="ip">
              Adresse IP
            </SortTh>
            <SortTh state={sort} sortKey="device">
              Appareil
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
          ) : (
            (sort.rows ?? []).map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap tabular-nums">{formatDateTime(r.at)}</td>
                <td>{r.memberName ?? r.username ?? '—'}</td>
                <td>
                  {r.success ? (
                    <Badge variant="success">Réussie</Badge>
                  ) : (
                    <Badge variant="destructive">Échec</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap tabular-nums">{formatDateTime(r.logoutAt)}</td>
                <td className="tabular-nums">{r.ip ?? ''}</td>
                <td
                  className="max-w-64 truncate text-xs text-muted-foreground"
                  title={r.device ?? ''}
                >
                  {r.device ?? ''}
                </td>
              </tr>
            ))
          )}
        </tbody>
        <NoMatchRow state={sort} total={data?.length} />
      </Table>
    </Card>
  );
}
