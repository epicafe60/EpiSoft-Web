import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Badge, Card, Table } from '@/components/ui/card';
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

/** R-AUTH-07: connection log, including failed attempts. */
export function LoginsPage() {
  const { data, error, isPending } = useQuery({
    queryKey: ['logins'],
    queryFn: () => api.get<LoginRow[]>('/admin/logins?limit=200'),
  });
  if (error) return <QueryError error={error} />;
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Utilisateur</th>
            <th>Résultat</th>
            <th>Déconnexion</th>
            <th>Adresse IP</th>
            <th>Appareil</th>
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
            data.map((r) => (
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
      </Table>
    </Card>
  );
}
