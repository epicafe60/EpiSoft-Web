import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatQty, parseQtyToMilli, type ExpiryStatus } from '@episoft/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Field, Input } from '@/components/ui/form';
import { ProductPicker } from '@/components/product-picker';
import type { ProductListItem } from '@/lib/types';
import { QueryError } from '../errors';

interface Batch {
  id: string;
  name: string;
  bestBefore: string;
  qty: string;
  note: string | null;
  daysLeft: number;
  status: ExpiryStatus;
}

const fr = (iso: string) => iso.split('-').reverse().join('/');
const tone: Record<ExpiryStatus, string> = {
  EXPIRED: 'text-destructive font-medium',
  SOON: 'text-warning font-medium',
  OK: 'text-muted-foreground',
};

/** R-STK-07: dated batches to watch; a past date can be written off into the stock ledger. */
export function BatchesCard() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['batches'],
    queryFn: () => api.get<Batch[]>('/stock/batches'),
  });
  const [product, setProduct] = useState<ProductListItem | null>(null);
  const [date, setDate] = useState('');
  const [qty, setQty] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    void queryClient.invalidateQueries({ queryKey: ['valuation'] });
  };
  const add = useMutation({
    mutationFn: () => api.post('/stock/batches', { productId: product!.id, bestBefore: date, qty }),
    onSuccess: () => {
      setProduct(null);
      setDate('');
      setQty('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (v: { id: string; discard: boolean }) =>
      api.delete(`/stock/batches/${v.id}${v.discard ? '?discard=true' : ''}`),
    onSuccess: refresh,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dates limites</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {list.error ? <QueryError error={list.error} /> : null}
        <Table>
          <tbody>
            {(list.data ?? []).map((b) => (
              <tr key={b.id} data-testid="batch-row">
                <td>{b.name}</td>
                <td className="text-right tabular-nums">
                  {formatQty(parseQtyToMilli(b.qty) ?? 0)}
                </td>
                <td className={`text-right tabular-nums ${tone[b.status]}`}>
                  {fr(b.bestBefore)}
                  {b.status === 'EXPIRED'
                    ? ' (périmé)'
                    : b.status === 'SOON'
                      ? ` (J-${b.daysLeft})`
                      : ''}
                </td>
                <td className="text-right whitespace-nowrap">
                  {b.status === 'EXPIRED' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => remove.mutate({ id: b.id, discard: true })}
                    >
                      Jeter
                    </Button>
                  ) : null}{' '}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove.mutate({ id: b.id, discard: false })}
                  >
                    Retirer
                  </Button>
                </td>
              </tr>
            ))}
            {list.data?.length === 0 ? (
              <tr>
                <td className="text-muted-foreground">Aucun lot suivi.</td>
              </tr>
            ) : null}
          </tbody>
        </Table>
        {product ? (
          <p className="text-sm">
            <strong>{product.name}</strong>{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => setProduct(null)}
            >
              changer
            </button>
          </p>
        ) : (
          <ProductPicker onPick={setProduct} />
        )}
        <div className="grid gap-3 sm:grid-cols-[8rem_10rem_auto] sm:items-end">
          <Field label="Quantité">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
          <Field label="À consommer avant">
            {(p) => (
              <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <Button
            onClick={() => add.mutate()}
            disabled={!product || !qty || !date || add.isPending}
          >
            Suivre ce lot
          </Button>
        </div>
        {add.error ? <Alert>{add.error.message}</Alert> : null}
        {remove.error ? <Alert>{remove.error.message}</Alert> : null}
        <p className="text-xs text-muted-foreground">
          « Jeter » enregistre la perte dans le stock ; « Retirer » sort seulement le lot de la
          liste.
        </p>
      </CardContent>
    </Card>
  );
}
