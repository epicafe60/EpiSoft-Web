import { useQuery } from '@tanstack/react-query';
import type { ProcessingActivity } from '@episoft/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryError } from '../errors';

type Row = Omit<ProcessingActivity, 'tables'> & { tables: { table: string; rows: number }[] };

/** Art. 30 RGPD: the register of processing, generated from the list kept next to the code. */
export function RegisterPage() {
  const { data, error } = useQuery({
    queryKey: ['processing-register'],
    queryFn: () => api.get<Row[]>('/admin/processing-register'),
  });
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Registre des traitements de données personnelles (art. 30 du RGPD). Les durées de
        conservation sont des références du code ; la politique de conservation paramétrable les
        remplacera.
      </p>
      {error ? <QueryError error={error} /> : null}
      {data?.map((a) => (
        <Card key={a.id}>
          <CardHeader>
            <CardTitle className="text-base">{a.name}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <p>
              <strong>Pourquoi :</strong> {a.purpose}
            </p>
            <p>
              <strong>Base légale :</strong> {a.basis}
            </p>
            <p>
              <strong>Données :</strong> {a.data.join(', ')}
            </p>
            <p>
              <strong>Personnes :</strong> {a.people}
            </p>
            <p>
              <strong>Destinataires :</strong> {a.recipients}
            </p>
            <p>
              <strong>Conservation :</strong> {a.retention}
            </p>
            <p className="text-xs text-muted-foreground">
              Tables : {a.tables.map((t) => `${t.table} (${t.rows})`).join(', ')}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
