import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, Table } from '@/components/ui/card';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';
import { Stars } from '../shop/reviews';

interface Pending {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  productName: string;
  firstName: string;
  lastName: string;
}

/** Moderation queue of the customer reviews. */
export function ReviewsModerationPage() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['reviews-pending'],
    queryFn: () => api.get<Pending[]>('/reviews/pending'),
  });
  const moderate = useMutation({
    mutationFn: (v: { id: string; status: 'APPROVED' | 'HIDDEN' }) =>
      api.post(`/reviews/${v.id}/moderate`, { status: v.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reviews-pending'] }),
  });
  return (
    <div>
      <PageHeader
        title="Avis clients"
        description="Les avis ne sont publiés dans la boutique qu'après votre accord."
      />
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <th>Produit</th>
              <th>Auteur</th>
              <th>Note</th>
              <th>Commentaire</th>
              <th className="w-0" />
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="font-medium">{r.productName}</td>
                <td>
                  {r.firstName} {r.lastName}
                  <div className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</div>
                </td>
                <td>
                  <Stars value={r.rating} /> <span className="sr-only">{r.rating} sur 5</span>
                </td>
                <td className="max-w-md">
                  {r.comment ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => moderate.mutate({ id: r.id, status: 'APPROVED' })}
                    >
                      <Check /> Publier
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => moderate.mutate({ id: r.id, status: 'HIDDEN' })}
                    >
                      <EyeOff /> Masquer
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {data?.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucun avis à modérer.
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
