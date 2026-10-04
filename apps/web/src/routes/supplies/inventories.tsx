import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Plus, ScanLine } from 'lucide-react';
import { formatQty, normalizeSearch, parseQtyToMilli, UNIT_LABELS } from '@episoft/shared';
import { api } from '@/lib/api';
import { euro } from '@/lib/format';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { NoMatchRow, SortTh, useSort } from '@/components/ui/sortable';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import type { CatalogRefs } from '@/lib/types';
import type { InventoryDetail, InventoryReport, InventoryRow } from '@/lib/types-supplies';
import { QueryError } from '../errors';

const STATUS = { OPEN: 'En cours', VALIDATED: 'Validé', CANCELLED: 'Annulé' } as const;

const INVENTORY_SORT = {
  label: (s: InventoryRow) => s.label,
  openedAt: (s: InventoryRow) => s.openedAt,
  status: (s: InventoryRow) => STATUS[s.status],
  counted: (s: InventoryRow) => s.counted,
};

export function InventoriesPage() {
  const navigate = useNavigate();
  const { data, error } = useQuery({
    queryKey: ['inventories'],
    queryFn: () => api.get<InventoryRow[]>('/inventories'),
  });
  const sort = useSort(data, INVENTORY_SORT, { key: 'openedAt', dir: 'desc' });
  const refs = useQuery({
    queryKey: ['catalog-refs'],
    queryFn: () => api.get<CatalogRefs>('/catalog/refs'),
  });
  const [label, setLabel] = useState(`Inventaire du ${new Date().toLocaleDateString('fr-FR')}`);
  const [scope, setScope] = useState<'all' | 'supplier' | 'category'>('all');
  const [scopeId, setScopeId] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/inventories', {
        label,
        scope:
          scope === 'supplier'
            ? { supplierId: scopeId }
            : scope === 'category'
              ? { categoryId: scopeId }
              : {},
      }),
    onSuccess: (r) => navigate({ to: '/appros/inventaires/$id', params: { id: r.id } }),
  });
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nouvel inventaire</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field label="Libellé">
            {(p) => (
              <Input
                {...p}
                className="w-72"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          <Field label="Périmètre">
            {(p) => (
              <Select
                {...p}
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as typeof scope);
                  setScopeId('');
                }}
              >
                <option value="all">Tout le catalogue</option>
                <option value="supplier">Un fournisseur</option>
                <option value="category">Un rayon</option>
              </Select>
            )}
          </Field>
          {scope !== 'all' ? (
            <Field label={scope === 'supplier' ? 'Fournisseur' : 'Rayon'}>
              {(p) => (
                <Select
                  {...p}
                  className="w-64"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                >
                  <option value="">Choisir…</option>
                  {(scope === 'supplier'
                    ? (refs.data?.suppliers ?? [])
                    : (refs.data?.categories ?? [])
                  ).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || (scope !== 'all' && !scopeId)}
          >
            <Plus /> Ouvrir l’inventaire
          </Button>
          {create.error ? <Alert>{create.error.message}</Alert> : null}
        </CardContent>
      </Card>
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="label">
                Inventaire
              </SortTh>
              <SortTh state={sort} sortKey="openedAt">
                Ouvert le
              </SortTh>
              <SortTh state={sort} sortKey="status">
                État
              </SortTh>
              <SortTh state={sort} sortKey="counted" className="text-right">
                Comptés
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {(sort.rows ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  <Link
                    to="/appros/inventaires/$id"
                    params={{ id: s.id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {s.label}
                  </Link>
                </td>
                <td className="tabular-nums">{formatDateTime(s.openedAt)}</td>
                <td>
                  <Badge
                    variant={
                      s.status === 'VALIDATED'
                        ? 'success'
                        : s.status === 'OPEN'
                          ? 'default'
                          : 'muted'
                    }
                  >
                    {STATUS[s.status]}
                  </Badge>
                </td>
                <td className="text-right tabular-nums">
                  {s.counted} / {s.lines}
                </td>
              </tr>
            ))}
          </tbody>
          <NoMatchRow state={sort} total={data?.length} />
        </Table>
      </Card>
    </div>
  );
}

/** R-STK-04: counting on a phone or tablet, by scan or search, cumulative. */
export function InventoryPage() {
  const { id } = useParams({ from: '/app/appros/inventaires/$id' });
  const queryClient = useQueryClient();
  const { data: s, error } = useQuery({
    queryKey: ['inventory', id],
    queryFn: () => api.get<InventoryDetail>(`/inventories/${id}`),
  });
  const report = useQuery({
    queryKey: ['inventory-report', id],
    queryFn: () => api.get<InventoryReport>(`/inventories/${id}/report`),
    enabled: s?.status === 'VALIDATED',
  });
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<InventoryDetail['lines'][number] | null>(null);
  const [qty, setQty] = useState('');
  const [mode, setMode] = useState<'add' | 'set'>('add');
  const [validating, setValidating] = useState(false);
  const [zero, setZero] = useState(false);
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('todo');
  const searchRef = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inventory', id] });

  const count = useMutation({
    mutationFn: () => api.put(`/inventories/${id}/lines/${selected!.productId}`, { mode, qty }),
    onSuccess: async () => {
      await refresh();
      setSelected(null);
      setQty('');
      setQ('');
      searchRef.current?.focus();
    },
  });
  const validate = useMutation({
    mutationFn: () =>
      api.post<{ adjusted: number }>(`/inventories/${id}/validate`, { zeroUncounted: zero }),
    onSuccess: async () => {
      setValidating(false);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['inventories'] });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/inventories/${id}/cancel`),
    onSuccess: refresh,
  });

  const matches = useMemo(() => {
    if (!s) return [];
    const t = q.trim();
    if (!t) return [];
    if (/^\d+$/.test(t)) return s.lines.filter((l) => l.code === t || l.eans.includes(t));
    const words = normalizeSearch(t).split(' ');
    return s.lines
      .filter((l) => words.every((w) => normalizeSearch(l.name).includes(w)))
      .slice(0, 10);
  }, [q, s]);

  if (error) return <QueryError error={error} />;
  if (!s) return <p className="text-muted-foreground">Chargement…</p>;
  const counted = s.lines.filter((l) => l.countedQty !== null).length;
  const shown = s.lines.filter((l) =>
    filter === 'all' ? true : filter === 'todo' ? l.countedQty === null : l.countedQty !== null,
  );

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    if (matches.length === 1) setSelected(matches[0]!);
  };

  return (
    <div className="grid gap-4">
      <Breadcrumbs
        items={[
          { label: 'Approvisionnements', to: '/appros' },
          { label: 'Inventaires', to: '/appros/inventaires' },
          { label: s.label },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {s.label}{' '}
            <Badge variant={s.status === 'VALIDATED' ? 'success' : 'default'}>
              {STATUS[s.status]}
            </Badge>
          </h2>
          <p className="text-sm text-muted-foreground">
            Ouvert le {formatDateTime(s.openedAt)} · {counted} / {s.lines.length} produits comptés
          </p>
        </div>
        {s.status === 'OPEN' ? (
          <div className="flex gap-2">
            <Button onClick={() => setValidating(true)}>
              <ClipboardCheck /> Valider
            </Button>
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() =>
                window.confirm('Annuler cet inventaire ? Aucun stock ne sera modifié.') &&
                cancel.mutate()
              }
            >
              Annuler
            </Button>
          </div>
        ) : null}
      </div>

      {s.status === 'OPEN' ? (
        <Card>
          <CardContent className="grid gap-3 pt-5">
            <form onSubmit={onSearch} className="relative">
              <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                autoFocus
                aria-label="Scanner ou rechercher un produit"
                placeholder="Scanner ou rechercher un produit…"
                className="h-12 pl-10 text-lg"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </form>
            {matches.length > 1 ? (
              <ul className="grid gap-1" role="listbox" aria-label="Produits">
                {matches.map((l) => (
                  <li key={l.productId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="flex min-h-11 w-full items-center justify-between rounded-md border px-3 text-left hover:bg-accent"
                      onClick={() => setSelected(l)}
                    >
                      <span>{l.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {l.countedQty !== null
                          ? `compté ${formatQty(parseQtyToMilli(l.countedQty)!)}`
                          : 'à compter'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {q && !matches.length ? (
              <p className="text-sm text-muted-foreground">
                Aucun produit de cet inventaire ne correspond.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {report.data ? (
        <Card className="print-area">
          <CardHeader>
            <CardTitle className="text-base">Rapport d’écarts</CardTitle>
            <p className="text-sm text-muted-foreground">
              Valeur des écarts : {euro(report.data.totalExcl)} HT · {euro(report.data.totalIncl)}{' '}
              TTC · {report.data.uncounted} produit(s) non compté(s), inchangé(s)
            </p>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <th>Produit</th>
                <th className="text-right">Théorique</th>
                <th className="text-right">Compté</th>
                <th className="text-right">Écart</th>
                <th className="text-right">Valeur HT</th>
                <th className="text-right">Valeur TTC</th>
              </tr>
            </thead>
            <tbody>
              {report.data.rows.map((r) => (
                <tr key={r.productId}>
                  <td>{r.name}</td>
                  <td className="text-right tabular-nums">
                    {formatQty(parseQtyToMilli(r.theoreticalQty)!)}
                  </td>
                  <td className="text-right tabular-nums">
                    {r.countedQty !== null ? formatQty(parseQtyToMilli(r.countedQty)!) : '—'}
                  </td>
                  <td
                    className={`text-right tabular-nums ${r.adjustment.startsWith('-') ? 'text-destructive' : 'text-success'}`}
                  >
                    {formatQty(parseQtyToMilli(r.adjustment)!)}
                  </td>
                  <td className="text-right tabular-nums">{euro(r.valueExcl)}</td>
                  <td className="text-right tabular-nums">{euro(r.valueIncl)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Produits</CardTitle>
            <Select
              aria-label="Filtre"
              className="w-40"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="todo">À compter</option>
              <option value="done">Comptés</option>
              <option value="all">Tous</option>
            </Select>
          </CardHeader>
          <Table>
            <tbody>
              {shown.map((l) => (
                <tr key={l.productId}>
                  <td>
                    {s.status === 'OPEN' ? (
                      <button
                        type="button"
                        className="text-left text-primary hover:underline"
                        onClick={() => setSelected(l)}
                      >
                        {l.name}
                      </button>
                    ) : (
                      l.name
                    )}
                    <span className="block text-xs text-muted-foreground">{l.categoryName}</span>
                  </td>
                  <td className="text-right tabular-nums text-muted-foreground">
                    théorique {formatQty(parseQtyToMilli(l.theoreticalQty)!)}
                  </td>
                  <td className="text-right tabular-nums font-medium">
                    {l.countedQty !== null ? formatQty(parseQtyToMilli(l.countedQty)!) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Dialog
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        description={
          selected?.countedQty !== null && selected
            ? `Déjà compté : ${formatQty(parseQtyToMilli(selected.countedQty!)!)}`
            : 'Pas encore compté'
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            count.mutate();
          }}
          className="grid gap-3"
        >
          <Field
            label={`Quantité${selected?.unit && selected.saleMode !== 'UNIT' ? ` (${UNIT_LABELS[selected.unit]})` : ''}`}
          >
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                autoFocus
                className="h-12 text-xl"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
          {selected?.countedQty !== null ? (
            <Select
              aria-label="Mode de saisie"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'add' | 'set')}
            >
              <option value="add">Ajouter au comptage déjà saisi</option>
              <option value="set">Remplacer le comptage</option>
            </Select>
          ) : null}
          {count.error ? <Alert>{count.error.message}</Alert> : null}
          <Button type="submit" size="lg" disabled={!qty || count.isPending}>
            Enregistrer
          </Button>
        </form>
      </Dialog>

      <Dialog
        open={validating}
        onClose={() => setValidating(false)}
        title="Valider l’inventaire"
        description={`${counted} produit(s) compté(s) recevront un mouvement d’inventaire.`}
      >
        <div className="grid gap-3">
          <div className="flex items-start gap-2">
            <Checkbox id="zero" checked={zero} onChange={(e) => setZero(e.target.checked)} />
            <Label htmlFor="zero" className="font-normal">
              Mettre à 0 les {s.lines.length - counted} produit(s) non compté(s). Sinon, leur stock
              est inchangé.
            </Label>
          </div>
          {zero ? (
            <Alert>
              Attention : le stock de tous les produits non comptés du périmètre passera à zéro.
            </Alert>
          ) : null}
          {validate.error ? <Alert>{validate.error.message}</Alert> : null}
          <Button onClick={() => validate.mutate()} disabled={validate.isPending}>
            Valider l’inventaire
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
