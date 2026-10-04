import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent } from '@/components/ui/card';
import { QueryError } from '../errors';

interface Report {
  at: string;
  errors: number;
  warnings: number;
  checks: {
    id: string;
    label: string;
    severity: 'error' | 'warning';
    count: number;
    samples: { ref: string; detail: string }[];
  }[];
}

/** Automated cross-checks of stock, cagnotte, tickets and accounting figures. */
export function IntegrityPage() {
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ['integrity'],
    queryFn: () => api.get<Report>('/admin/integrity'),
    staleTime: 0,
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
      {error ? <QueryError error={error} /> : null}
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
                    {c.samples.length ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-primary">
                          Voir les {Math.min(c.count, c.samples.length)} premiers cas
                        </summary>
                        <ul className="mt-2 grid gap-1 text-xs">
                          {c.samples.map((s, i) => (
                            <li key={i}>
                              <strong>{s.ref}</strong> — {s.detail}
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
    </div>
  );
}
