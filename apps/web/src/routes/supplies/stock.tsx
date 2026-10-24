import { Fragment, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, ShoppingCart } from 'lucide-react';
import { formatQty, parseQtyToMilli } from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, todayIso } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { useConfirm } from '@/components/confirm';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { ProductPicker } from '@/components/product-picker';
import type { ProductListItem } from '@/lib/types';
import { QueryError } from '../errors';
import { BatchesCard } from './batches-card';

interface ToOrder {
  id: string;
  code: string;
  name: string;
  stockQty: string;
  minStock: string;
  supplierId: string | null;
  supplierName: string | null;
}

interface Valuation {
  date: string;
  basis: 'excl' | 'incl';
  total: string;
  rows: {
    id: string;
    code: string;
    name: string;
    category: string | null;
    qty: string;
    price: string | null;
    value: string;
  }[];
}

export function StockPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toOrder = useQuery({
    queryKey: ['to-order'],
    queryFn: () => api.get<ToOrder[]>('/stock/to-order'),
  });
  const [date, setDate] = useState(todayIso());
  const [basis, setBasis] = useState<'excl' | 'incl'>('excl');
  const valuation = useQuery({
    queryKey: ['valuation', date, basis],
    queryFn: () => api.get<Valuation>(`/stock/valuation?date=${date}&basis=${basis}`),
    enabled: !!date,
  });
  const [lossProduct, setLossProduct] = useState<ProductListItem | null>(null);
  const [lossQty, setLossQty] = useState('');
  const [lossReason, setLossReason] = useState('');
  const loss = useMutation({
    mutationFn: () =>
      api.post('/stock/losses', { productId: lossProduct!.id, qty: lossQty, reason: lossReason }),
    onSuccess: () => {
      setLossProduct(null);
      setLossQty('');
      setLossReason('');
      void queryClient.invalidateQueries({ queryKey: ['valuation'] });
      void queryClient.invalidateQueries({ queryKey: ['to-order'] });
    },
  });
  const confirm = useConfirm();
  /** A loss that takes the stock below zero means a delivery or a count is missing somewhere. */
  const confirmLoss = async () => {
    const stock = parseQtyToMilli(lossProduct?.stockQty ?? '0') ?? 0;
    const qty = parseQtyToMilli(lossQty.replace(',', '.')) ?? 0;
    if (qty > stock) {
      const ok = await confirm({
        title: 'Le stock deviendrait négatif',
        message: `Il reste ${formatQty(stock)} de « ${lossProduct!.name} » en stock, et vous déclarez une perte de ${formatQty(qty)}. Un stock négatif veut dire qu’une réception ou un inventaire manque.`,
        impact: ['Vérifiez d’abord que la dernière livraison est bien enregistrée.'],
        confirmLabel: 'Enregistrer quand même',
        destructive: true,
      });
      if (!ok) return;
    }
    loss.mutate();
  };
  const order = useMutation({
    mutationFn: (supplierId: string) =>
      api.post<{ id: string }>('/purchase-orders', { supplierId }),
    onSuccess: (o) => navigate({ to: '/appros/commandes/$id', params: { id: o.id } }),
  });
  const bySupplier = new Map<string, ToOrder[]>();
  for (const p of toOrder.data ?? [])
    bySupplier.set(p.supplierId ?? '', [...(bySupplier.get(p.supplierId ?? '') ?? []), p]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
        <span className="text-sm text-muted-foreground">
          Données fournisseurs : produits sans fournisseur, fournisseurs sans produit.
        </span>
        <a
          className={buttonVariants({ variant: 'outline', className: 'ml-auto' })}
          href="/api/v1/supply-audit.xlsx"
        >
          Audit fournisseurs (Excel)
        </a>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">À commander (stock sous le minimum)</CardTitle>
        </CardHeader>
        {toOrder.error ? <QueryError error={toOrder.error} /> : null}
        <Table>
          <tbody>
            {[...bySupplier.entries()].map(([sid, items]) => (
              <Fragment key={`s-${sid}`}>
                <tr className="bg-muted/50">
                  <td colSpan={2} className="font-medium">
                    {items[0]!.supplierName ?? 'Sans fournisseur'}
                  </td>
                  <td className="text-right">
                    {sid ? (
                      <Button size="sm" variant="outline" onClick={() => order.mutate(sid)}>
                        <ShoppingCart /> Commander
                      </Button>
                    ) : null}
                  </td>
                </tr>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to="/catalogue/$id" params={{ id: p.id }} className="hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="text-right tabular-nums text-destructive">
                      {formatQty(parseQtyToMilli(p.stockQty) ?? 0)}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">
                      min {formatQty(parseQtyToMilli(p.minStock) ?? 0)}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {toOrder.data?.length === 0 ? (
              <tr>
                <td className="text-muted-foreground">Rien à commander.</td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>

      <div className="grid content-start gap-6">
        <BatchesCard />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Perte, casse, péremption</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {lossProduct ? (
              <p className="text-sm">
                <strong>{lossProduct.name}</strong> — stock{' '}
                {formatQty(parseQtyToMilli(lossProduct.stockQty) ?? 0)}{' '}
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setLossProduct(null)}
                >
                  changer
                </button>
              </p>
            ) : (
              <ProductPicker onPick={setLossProduct} />
            )}
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field label="Quantité">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={lossQty}
                    onChange={(e) => setLossQty(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Motif">
                {(p) => (
                  <Input
                    {...p}
                    placeholder="cassé, périmé, consommation interne…"
                    value={lossReason}
                    onChange={(e) => setLossReason(e.target.value)}
                  />
                )}
              </Field>
            </div>
            {loss.error ? <Alert>{loss.error.message}</Alert> : null}
            {loss.isSuccess ? <Alert variant="success">Perte enregistrée.</Alert> : null}
            <Button
              onClick={() => void confirmLoss()}
              disabled={!lossProduct || !lossQty || !lossReason || loss.isPending}
            >
              Enregistrer la perte
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Valorisation du stock</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Au">
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Prix">
                {(p) => (
                  <Select
                    {...p}
                    value={basis}
                    onChange={(e) => setBasis(e.target.value as 'excl' | 'incl')}
                  >
                    <option value="excl">dernier PA HT</option>
                    <option value="incl">dernier PA TTC</option>
                  </Select>
                )}
              </Field>
              <a
                className={buttonVariants({ variant: 'outline' })}
                href={`/api/v1/stock/valuation.xlsx?date=${date}&basis=${basis}`}
              >
                <FileSpreadsheet /> Excel
              </a>
            </div>
            {valuation.data ? (
              <p className="text-2xl font-semibold tabular-nums">
                {euro(valuation.data.total)}{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  pour {valuation.data.rows.length} produits en stock
                </span>
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
