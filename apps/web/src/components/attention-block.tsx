import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { hasAnyRole } from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Item {
  code: string;
  severity: 'error' | 'warning';
  count: number;
  label: string;
  link: string;
}

/** For the responsables: what deserves a look today, or the reassurance that nothing does. */
export function AttentionBlock() {
  const me = useMe();
  const allowed = hasAnyRole(me.roles, ['ADMIN', 'COMPTA']);
  const { data } = useQuery({
    queryKey: ['attention'],
    queryFn: () => api.get<Item[]>('/admin/attention'),
    enabled: allowed,
    refetchInterval: 5 * 60_000,
  });
  if (!allowed || !data) return null;
  if (!data.length)
    return (
      <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <CheckCircle2 className="size-4 text-success" /> Rien à signaler : les contrôles sont au
        vert.
      </p>
    );
  return (
    <Card className="mb-4 border-warning/60" aria-label="À surveiller">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-5 text-warning" /> À surveiller
          <Badge variant={data.some((i) => i.severity === 'error') ? 'destructive' : 'default'}>
            {data.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-1.5 text-sm">
          {data.map((i) => (
            <li key={i.code}>
              <Link
                to={i.link}
                className="flex items-start gap-2 rounded-md px-1 py-0.5 hover:bg-accent"
              >
                <AlertTriangle
                  className={`mt-0.5 size-4 shrink-0 ${i.severity === 'error' ? 'text-destructive' : 'text-warning'}`}
                />
                <span>
                  <strong className="tabular-nums">{i.count}</strong> {i.label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
