import { Fragment, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import {
  CSRF_HEADER,
  formatQty,
  inclFromExcl4,
  margin,
  parseAmountToCents,
  bulkPriceImpact,
  parsePrice4,
  parseQtyToMilli,
  VAT_RATES,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { useThresholds } from '@/lib/thresholds';
import { euro } from '@/lib/format';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/confirm';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Checkbox, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import type { CatalogRefs, ProductListItem } from '@/lib/types';
import { MOVEMENT_KIND_LABELS, type MovementRow, type SupplierRow } from '@/lib/types-supplies';
import { PageHeader } from '../shell';
import { QueryError } from '../errors';

/** R-PRD-06: the label queue, printed as an A4 PDF sheet. */
export function LabelsPage() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['products', 'labels'],
    queryFn: () => api.get<ProductListItem[]>('/products?labelPending=true&limit=1000'),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [perPage, setPerPage] = useState<24 | 40>(24);
  const [markDone, setMarkDone] = useState(true);
  const [barcode, setBarcode] = useState(true);
  useEffect(() => setSelected((data ?? []).map((p) => p.id)), [data]);
  const print = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v1/products/labels/pdf', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
        body: JSON.stringify({ productIds: selected, perPage, markDone, barcode }),
      });
      if (!res.ok) throw new Error('Génération impossible.');
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });
  return (
    <>
      <PageHeader
        title="Étiquettes à imprimer"
        description="Produits créés, dont le prix a changé ou demandés."
      />
      {error ? <QueryError error={error} /> : null}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          aria-label="Format"
          className="w-56"
          value={perPage}
          onChange={(e) => setPerPage(Number(e.target.value) as 24 | 40)}
        >
          <option value={24}>A4, 24 étiquettes (3 × 8)</option>
          <option value={40}>A4, 40 étiquettes (4 × 10)</option>
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox id="done" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />
          <Label htmlFor="done" className="font-normal">
            Retirer de la file après impression
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="barcode" checked={barcode} onChange={(e) => setBarcode(e.target.checked)} />
          <Label htmlFor="barcode" className="font-normal">
            Avec code-barres (les pastilles rouge « local » et verte « bio » sont toujours
            imprimées)
          </Label>
        </div>
        <Button onClick={() => print.mutate()} disabled={!selected.length || print.isPending}>
          <Printer /> Imprimer {selected.length} étiquette(s)
        </Button>
      </div>
      {print.error ? <Alert>{print.error.message}</Alert> : null}
      <Card>
        <Table>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id}>
                <td className="w-8">
                  <Checkbox
                    aria-label={p.name}
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id),
                      )
                    }
                  />
                </td>
                <td>
                  <Link to="/catalogue/$id" params={{ id: p.id }} className="hover:underline">
                    {p.name}
                  </Link>
                </td>
                <td className="text-right tabular-nums">{euro(p.salePrice)}</td>
              </tr>
            ))}
            {data?.length === 0 ? (
              <tr>
                <td className="text-muted-foreground">Aucune étiquette en attente.</td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

interface GridRow {
  productId: string;
  code: string;
  name: string;
  supplierRef: string | null;
  purchasePriceExcl: string | null;
  vatRate: string;
  salePrice: string;
  status: string;
}

/** R-PRD-08: bulk price update for a supplier — editable grid, preview of changes, one validation. */
export function BulkPricesPage() {
  const queryClient = useQueryClient();
  const suppliers = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.get<SupplierRow[]>('/suppliers'),
  });
  const [supplierId, setSupplierId] = useState('');
  const grid = useQuery({
    queryKey: ['price-grid', supplierId],
    queryFn: () => api.get<GridRow[]>(`/suppliers/${supplierId}/price-grid`),
    enabled: !!supplierId,
  });
  const [rows, setRows] = useState<(GridRow & { pa: string; pv: string; active: boolean })[]>([]);
  useEffect(() => {
    setRows(
      (grid.data ?? []).map((r) => ({
        ...r,
        pa: r.purchasePriceExcl ? String(Number(r.purchasePriceExcl)) : '',
        pv: r.salePrice,
        active: r.status !== 'INACTIVE',
      })),
    );
  }, [grid.data]);
  const changed = rows.filter((r, i) => {
    const o = grid.data?.[i];
    return (
      o &&
      (r.pa !== (o.purchasePriceExcl ? String(Number(o.purchasePriceExcl)) : '') ||
        r.vatRate !== o.vatRate ||
        parseAmountToCents(r.pv) !== parseAmountToCents(o.salePrice) ||
        r.active !== (o.status !== 'INACTIVE'))
    );
  });
  const apply = useMutation({
    mutationFn: () =>
      api.post<{ changed: number }>('/products/bulk-prices', {
        rows: changed.map((r) => ({
          productId: r.productId,
          purchasePriceExcl: r.pa || null,
          vatRate: r.vatRate,
          salePrice: r.pv,
          active: r.active,
        })),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['price-grid', supplierId] }),
  });
  const set = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const confirm = useConfirm();
  const thresholds = useThresholds();
  /** A grid changes many prices at once: show what it will do before it does it. */
  const confirmApply = async () => {
    const impact = bulkPriceImpact(
      changed.map((r) => {
        const o = grid.data?.find((g) => g.productId === r.productId);
        return {
          oldSaleCents: o ? parseAmountToCents(o.salePrice) : null,
          newSaleCents: parseAmountToCents(r.pv) ?? 0,
          newPurchase4: r.pa ? parsePrice4(r.pa) : null,
          vatRate: r.vatRate,
          wasActive: o ? o.status !== 'INACTIVE' : true,
          active: r.active,
        };
      }),
      thresholds,
    );
    const lines = [`${impact.count} produit(s) seront modifiés.`];
    if (impact.avgSalePct !== null)
      lines.push(
        `Variation moyenne du prix de vente : ${impact.avgSalePct.toFixed(1).replace('.', ',')} % (la plus forte : ${impact.maxSalePct!.toFixed(0)} %).`,
      );
    if (impact.bigJumps)
      lines.push(
        `${impact.bigJumps} prix de vente changent de plus de moitié ou presque : vérifiez-les.`,
      );
    if (impact.belowCost)
      lines.push(`${impact.belowCost} produit(s) seront vendus moins cher que leur prix d’achat.`);
    if (impact.saleZero)
      lines.push(`${impact.saleZero} produit(s) auront un prix de vente de 0 €.`);
    if (impact.deactivated)
      lines.push(`${impact.deactivated} produit(s) seront désactivés (plus vendables en caisse).`);
    const risky = impact.bigJumps + impact.belowCost + impact.saleZero > 0;
    const ok = await confirm({
      title: 'Appliquer ces prix ?',
      message: risky
        ? 'Certains changements sortent de l’ordinaire. Relisez-les avant de valider.'
        : 'Les nouveaux prix s’appliquent tout de suite en caisse, et les étiquettes à imprimer sont signalées.',
      impact: lines,
      confirmLabel: 'Appliquer les prix',
      destructive: risky,
    });
    if (ok) apply.mutate();
  };
  return (
    <>
      <PageHeader
        title="Mise à jour des prix"
        description="Grille d’un fournisseur : PA HT, TVA, PV et activation."
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          aria-label="Fournisseur"
          className="w-64"
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
        >
          <option value="">Choisir un fournisseur…</option>
          {(suppliers.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {changed.length ? (
          <Button onClick={() => void confirmApply()} disabled={apply.isPending}>
            Valider {changed.length} modification(s)
          </Button>
        ) : null}
        {apply.isSuccess ? (
          <span className="text-sm text-success">{apply.data.changed} produit(s) mis à jour.</span>
        ) : null}
      </div>
      {apply.error ? <Alert>{apply.error.message}</Alert> : null}
      {rows.length ? (
        <Card>
          <Table>
            <thead>
              <tr>
                <th>Produit</th>
                <th className="w-28 text-right">PA HT</th>
                <th className="w-28">TVA</th>
                <th className="text-right">PA TTC</th>
                <th className="w-28 text-right">PV TTC</th>
                <th className="text-right">Marque</th>
                <th className="w-16">Actif</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const incl = r.pa ? inclFromExcl4(parsePrice4(r.pa) ?? 0, r.vatRate) : null;
                const m = margin(parseAmountToCents(r.pv) ?? 0, incl);
                const isChanged = changed.includes(r);
                return (
                  <tr key={r.productId} className={isChanged ? 'bg-primary/5' : ''}>
                    <td>
                      {r.name}{' '}
                      <span className="text-xs text-muted-foreground">{r.supplierRef}</span>
                    </td>
                    <td>
                      <Input
                        aria-label={`PA HT ${r.name}`}
                        inputMode="decimal"
                        className="text-right"
                        value={r.pa}
                        onChange={(e) => set(i, { pa: e.target.value })}
                      />
                    </td>
                    <td>
                      <Select
                        aria-label={`TVA ${r.name}`}
                        value={r.vatRate}
                        onChange={(e) => set(i, { vatRate: e.target.value })}
                      >
                        {VAT_RATES.map((v) => (
                          <option key={v} value={v}>
                            {Number(v).toLocaleString('fr-FR')} %
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="text-right tabular-nums">
                      {incl !== null ? euro(incl / 10_000) : '—'}
                    </td>
                    <td>
                      <Input
                        aria-label={`PV ${r.name}`}
                        inputMode="decimal"
                        className="text-right"
                        value={r.pv}
                        onChange={(e) => set(i, { pv: e.target.value })}
                      />
                    </td>
                    <td className="text-right tabular-nums">
                      {m ? `${m.ratePct.toLocaleString('fr-FR')} %` : '—'}
                    </td>
                    <td>
                      <Checkbox
                        aria-label={`Actif ${r.name}`}
                        checked={r.active}
                        onChange={(e) => set(i, { active: e.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}

/** R-PRD-09: universes and shelves. */
export function ShelvesPage() {
  const queryClient = useQueryClient();
  const refs = useQuery({
    queryKey: ['catalog-refs'],
    queryFn: () => api.get<CatalogRefs>('/catalog/refs'),
  });
  const [newShelf, setNewShelf] = useState<Record<string, { code: string; name: string }>>({});
  const [universe, setUniverse] = useState({ code: '', name: '' });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['catalog-refs'] });
  const addShelf = useMutation({
    mutationFn: (universeId: string) =>
      api.post('/categories', {
        universeId,
        code: newShelf[universeId]!.code,
        name: newShelf[universeId]!.name,
        sort: Number(newShelf[universeId]!.code) || 0,
      }),
    onSuccess: (_r, universeId) => {
      setNewShelf({ ...newShelf, [universeId]: { code: '', name: '' } });
      void invalidate();
    },
  });
  const addUniverse = useMutation({
    mutationFn: () => api.post('/universes', { ...universe, sort: Number(universe.code) || 0 }),
    onSuccess: () => {
      setUniverse({ code: '', name: '' });
      void invalidate();
    },
  });
  const rename = useMutation({
    mutationFn: (c: CatalogRefs['categories'][number]) =>
      api.put(`/categories/${c.id}`, {
        universeId: c.universeId,
        code: c.code,
        name: c.name,
        sort: c.sort,
        shopVisible: c.shopVisible,
      }),
    onSuccess: invalidate,
  });
  if (refs.error) return <QueryError error={refs.error} />;
  return (
    <>
      <PageHeader
        title="Univers et rayons"
        description="Le code produit vaut univers + rayon + séquence."
      />
      {addShelf.error || addUniverse.error ? (
        <Alert className="mb-4">{(addShelf.error ?? addUniverse.error)!.message}</Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {(refs.data?.universes ?? []).map((u) => (
          <Card key={u.id}>
            <CardHeader>
              <CardTitle className="text-base">
                {u.code} · {u.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {(refs.data?.categories ?? [])
                .filter((c) => c.universeId === u.id)
                .map((c) => (
                  <Fragment key={c.id}>
                    <div className="flex items-center gap-2">
                      <span className="w-8 tabular-nums text-muted-foreground">{c.code}</span>
                      <Input
                        aria-label={`Rayon ${c.code}`}
                        defaultValue={c.name}
                        onBlur={(e) =>
                          e.target.value.trim() &&
                          e.target.value !== c.name &&
                          rename.mutate({ ...c, name: e.target.value.trim() })
                        }
                      />
                      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox
                          aria-label={`Rayon ${c.code} visible dans la boutique`}
                          checked={c.shopVisible}
                          onChange={(e) => rename.mutate({ ...c, shopVisible: e.target.checked })}
                        />
                        Boutique
                      </label>
                    </div>
                  </Fragment>
                ))}
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Code du nouveau rayon"
                  placeholder="Code"
                  className="w-20"
                  maxLength={2}
                  value={newShelf[u.id]?.code ?? ''}
                  onChange={(e) =>
                    setNewShelf({
                      ...newShelf,
                      [u.id]: { name: newShelf[u.id]?.name ?? '', code: e.target.value },
                    })
                  }
                />
                <Input
                  aria-label="Nom du nouveau rayon"
                  placeholder="Nouveau rayon"
                  value={newShelf[u.id]?.name ?? ''}
                  onChange={(e) =>
                    setNewShelf({
                      ...newShelf,
                      [u.id]: { code: newShelf[u.id]?.code ?? '', name: e.target.value },
                    })
                  }
                />
                <Button
                  size="sm"
                  onClick={() => addShelf.mutate(u.id)}
                  disabled={!newShelf[u.id]?.code || !newShelf[u.id]?.name}
                >
                  Ajouter
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nouvel univers</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2">
            <Input
              aria-label="Code de l’univers"
              placeholder="Code"
              className="w-20"
              maxLength={1}
              value={universe.code}
              onChange={(e) => setUniverse({ ...universe, code: e.target.value })}
            />
            <Input
              aria-label="Nom de l’univers"
              placeholder="Nom"
              value={universe.name}
              onChange={(e) => setUniverse({ ...universe, name: e.target.value })}
            />
            <Button
              size="sm"
              onClick={() => addUniverse.mutate()}
              disabled={!universe.code || !universe.name}
            >
              Ajouter
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** R-STK-05: movements of a product with the running balance, and a manual correction. */
export function StockHistoryCard({
  productId,
  canCorrect,
}: {
  productId: string;
  canCorrect: boolean;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['movements', productId],
    queryFn: () => api.get<MovementRow[]>(`/stock/movements?productId=${productId}`),
  });
  const [qty, setQty] = useState('');
  const [comment, setComment] = useState('');
  const correct = useMutation({
    mutationFn: () => api.post('/stock/corrections', { productId, qty, comment }),
    onSuccess: async () => {
      setQty('');
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['movements', productId] });
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mouvements de stock</CardTitle>
      </CardHeader>
      {canCorrect ? (
        <CardContent className="grid gap-2">
          <div className="flex gap-2">
            <Input
              aria-label="Correction (± quantité)"
              placeholder="± qté"
              className="w-24"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
            <Input
              aria-label="Motif de la correction"
              placeholder="Motif"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button
              size="sm"
              onClick={() => correct.mutate()}
              disabled={!qty || !comment || correct.isPending}
            >
              Corriger
            </Button>
          </div>
          {correct.error ? <Alert>{correct.error.message}</Alert> : null}
        </CardContent>
      ) : null}
      <div className="max-h-80 overflow-y-auto">
        <Table>
          <tbody>
            {(data ?? []).map((m) => (
              <tr key={m.id}>
                <td className="text-xs tabular-nums">{formatDateTime(m.at)}</td>
                <td className="text-xs">
                  {MOVEMENT_KIND_LABELS[m.kind] ?? m.kind}
                  {m.comment ? (
                    <span className="block text-muted-foreground">{m.comment}</span>
                  ) : null}
                </td>
                <td
                  className={`text-right tabular-nums ${m.qty.startsWith('-') ? 'text-destructive' : ''}`}
                >
                  {formatQty(parseQtyToMilli(m.qty)!)}
                </td>
                <td className="text-right tabular-nums text-muted-foreground">
                  {formatQty(parseQtyToMilli(m.balance)!)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
