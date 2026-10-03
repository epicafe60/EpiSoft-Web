import { hasAnyRole } from '@episoft/shared';
import { useDeferredValue, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Tag } from 'lucide-react';
import {
  formatQty,
  parseQtyToMilli,
  PRODUCT_STATUS_LABELS,
  PRODUCT_STATUSES,
  UNIT_LABELS,
  type ProductStatus,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { euro } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, Table } from '@/components/ui/card';
import { Checkbox, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import type { ProductListItem } from '@/lib/types';
import { PageHeader } from '../shell';
import { SortTh, useSort } from '@/components/ui/sortable';
import { QueryError } from '../errors';

const PRODUCT_SORT = {
  code: (p: ProductListItem) => p.code,
  name: (p: ProductListItem) => p.name,
  category: (p: ProductListItem) => p.categoryName,
  price: (p: ProductListItem) => Number(p.salePrice),
  stock: (p: ProductListItem) => Number(p.stockQty),
};

export function ProductsPage() {
  const me = useMe();
  const canEdit = hasAnyRole(me.roles, ['PRODUITS']);
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ProductStatus | ''>('ACTIVE');
  const [labels, setLabels] = useState(false);
  const query = useDeferredValue(q.trim());
  const { data, error, isPending } = useQuery({
    queryKey: ['products', query, status, labels],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '1000' });
      if (query) p.set('q', query);
      if (status) p.set('status', status);
      if (labels) p.set('labelPending', 'true');
      return api.get<ProductListItem[]>(`/products?${p}`);
    },
    placeholderData: (prev) => prev,
  });
  const sort = useSort(data, PRODUCT_SORT);
  const labelsDone = useMutation({
    mutationFn: (ids: string[]) => api.post('/products/labels/done', { ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });

  return (
    <>
      <PageHeader
        title="Catalogue"
        description="Produits, prix et boutons de caisse."
        actions={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Link to="/catalogue/etiquettes" className={buttonVariants({ variant: 'outline' })}>
                Étiquettes
              </Link>
              <Link to="/catalogue/prix" className={buttonVariants({ variant: 'outline' })}>
                Prix en masse
              </Link>
              <Link to="/catalogue/rayons" className={buttonVariants({ variant: 'outline' })}>
                Rayons
              </Link>
              <Link to="/catalogue/nouveau" className={buttonVariants()}>
                <Plus /> Nouveau produit
              </Link>
            </div>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Rechercher un produit"
            placeholder="Nom, code ou code-barres…"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select
          aria-label="Statut"
          className="w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value as ProductStatus | '')}
        >
          <option value="">Tous les statuts</option>
          {PRODUCT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PRODUCT_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox id="labels" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
          <Label htmlFor="labels" className="font-normal">
            Étiquettes à imprimer
          </Label>
        </div>
        {labels && canEdit && data?.length ? (
          <Button
            variant="outline"
            onClick={() => labelsDone.mutate(data.map((p) => p.id))}
            disabled={labelsDone.isPending}
          >
            <Tag /> Marquer les {data.length} étiquettes comme faites
          </Button>
        ) : null}
      </div>
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="code" className="w-20">
                Code
              </SortTh>
              <SortTh state={sort} sortKey="name">
                Produit
              </SortTh>
              <SortTh state={sort} sortKey="category" className="hidden md:table-cell">
                Rayon
              </SortTh>
              <SortTh state={sort} sortKey="price" className="text-right">
                Prix
              </SortTh>
              <SortTh state={sort} sortKey="stock" className="text-right">
                Stock
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
                  Aucun produit.
                </td>
              </tr>
            ) : (
              sort.rows?.map((p) => {
                const stock = parseQtyToMilli(p.stockQty) ?? 0;
                const low = p.minStock !== null && stock < (parseQtyToMilli(p.minStock) ?? 0);
                return (
                  <tr key={p.id}>
                    <td className="tabular-nums text-muted-foreground">{p.code}</td>
                    <td>
                      <div className="flex items-center gap-3">
                        {p.imageId ? (
                          <img
                            src={`/api/v1/media/${p.imageId}`}
                            alt=""
                            className="size-8 rounded object-cover"
                            loading="lazy"
                          />
                        ) : null}
                        <div>
                          <Link
                            to="/catalogue/$id"
                            params={{ id: p.id }}
                            className="font-medium text-primary hover:underline"
                          >
                            {p.name}
                          </Link>
                          <div className="flex flex-wrap gap-1">
                            {p.status !== 'ACTIVE' ? (
                              <Badge variant="muted">{PRODUCT_STATUS_LABELS[p.status]}</Badge>
                            ) : null}
                            {p.kind === 'SERVICE' ? <Badge variant="muted">Service</Badge> : null}
                            {p.labelPending ? <Badge>Étiquette</Badge> : null}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="hidden text-muted-foreground md:table-cell">{p.categoryName}</td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {euro(p.salePrice)}
                      {p.saleMode !== 'UNIT' && p.unit ? (
                        <span className="text-muted-foreground"> /{UNIT_LABELS[p.unit]}</span>
                      ) : null}
                    </td>
                    <td
                      className={`text-right tabular-nums ${stock < 0 || low ? 'text-destructive' : ''}`}
                    >
                      {p.kind === 'SERVICE' ? '—' : formatQty(stock)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
