import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Download, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { euro, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { SortTh, useSort } from '@/components/ui/sortable';
import { LineChart } from '@/components/line-chart';
import { ReportTableView, type ReportTableData } from '@/components/report-table';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';

const KINDS = [
  ['sales', 'Ventes et marge'],
  ['trend', 'Tendance du CA'],
  ['payments', 'Modes de paiement'],
  ['purchases', 'Achats'],
  ['movements', 'Mouvements de stock'],
  ['households', 'Ventes par foyer'],
  ['dormant', 'Produits dormants'],
  ['hours', 'Heures de pointe'],
  ['losses', 'Pertes et casse'],
  ['forecast', 'Autonomie de stock'],
  ['suggest', 'Suggestion de commande'],
  ['cashgap', 'Écarts de caisse'],
] as const;
type Kind = (typeof KINDS)[number][0];

const GROUPS = [
  ['product', 'Produit'],
  ['category', 'Rayon'],
  ['universe', 'Univers'],
  ['supplier', 'Fournisseur'],
  ['day', 'Jour'],
  ['month', 'Mois'],
] as const;

const GRANULARITIES = [
  ['day', 'Jour'],
  ['week', 'Semaine'],
  ['month', 'Mois'],
] as const;

interface Ref {
  id: string;
  name: string;
  universeId?: string;
}
interface Refs {
  universes: Ref[];
  categories: Ref[];
  suppliers: Ref[];
}
interface AnalysisRow {
  key: string;
  label: string;
  qty: string;
  ttcCents: number;
  htCents: number;
  costCents: number;
  marginCents: number;
  marginRatePct: number | null;
}
interface Analysis {
  rows: AnalysisRow[];
  total: Omit<AnalysisRow, 'key' | 'label' | 'qty'>;
}
interface Trend {
  points: {
    period: string;
    cents: number;
    tickets: number;
    previousCents: number;
    previousTickets: number;
  }[];
}
interface Saved {
  id: string;
  name: string;
  kind: Kind;
  params: Record<string, string>;
  shared: boolean;
  createdBy: string | null;
}

const ACCESSORS = {
  label: (r: AnalysisRow) => r.label,
  qty: (r: AnalysisRow) => Number(r.qty),
  ttc: (r: AnalysisRow) => r.ttcCents,
  ht: (r: AnalysisRow) => r.htCents,
  cost: (r: AnalysisRow) => r.costCents,
  margin: (r: AnalysisRow) => r.marginCents,
  rate: (r: AnalysisRow) => r.marginRatePct,
};

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(2).replace('.', ',')} %`);
const cents = (c: number) => euro(c / 100);
const link = buttonVariants({ variant: 'outline' });

interface Filters {
  from: string;
  to: string;
  by: (typeof GROUPS)[number][0];
  granularity: (typeof GRANULARITIES)[number][0];
  supplierId: string;
  universeId: string;
  categoryId: string;
}

function SalesPanel({ f }: { f: Filters }) {
  const params = new URLSearchParams({ from: f.from, to: f.to, by: f.by });
  if (f.supplierId) params.set('supplierId', f.supplierId);
  if (f.universeId) params.set('universeId', f.universeId);
  if (f.categoryId) params.set('categoryId', f.categoryId);
  const { data, error, isFetching } = useQuery({
    queryKey: ['stats-analysis', params.toString()],
    queryFn: () => api.get<Analysis>(`/stats/analysis?${params}`),
    placeholderData: (prev) => prev,
  });
  const sort = useSort(data?.rows, ACCESSORS);
  const max = Math.max(1, ...(data?.rows ?? []).map((r) => Math.abs(r.htCents)));
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <a className={cn(link)} href={`/api/v1/stats/analysis?${params}&format=xlsx`}>
          <Download /> Exporter Excel
        </a>
      </div>
      {error ? <QueryError error={error} /> : null}
      <Card aria-busy={isFetching}>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="label">
                {GROUPS.find((g) => g[0] === f.by)?.[1]}
              </SortTh>
              <SortTh state={sort} sortKey="qty" className="text-right">
                Quantité
              </SortTh>
              <SortTh state={sort} sortKey="ttc" className="text-right">
                CA TTC
              </SortTh>
              <SortTh state={sort} sortKey="ht" className="text-right">
                CA HT
              </SortTh>
              <SortTh state={sort} sortKey="cost" className="text-right">
                Coût HT
              </SortTh>
              <SortTh state={sort} sortKey="margin" className="text-right">
                Marge
              </SortTh>
              <SortTh state={sort} sortKey="rate" className="text-right">
                Taux
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {sort.rows?.map((r) => (
              <tr key={r.key}>
                <td>
                  <div className="font-medium">{r.label}</div>
                  <div
                    aria-hidden
                    className="mt-1 h-1.5 rounded bg-primary/60"
                    style={{ width: `${Math.max(0, (r.htCents / max) * 100)}%` }}
                  />
                </td>
                <td className="text-right tabular-nums">{r.qty}</td>
                <td className="text-right tabular-nums">{cents(r.ttcCents)}</td>
                <td className="text-right tabular-nums">{cents(r.htCents)}</td>
                <td className="text-right tabular-nums">{cents(r.costCents)}</td>
                <td className="text-right tabular-nums">{cents(r.marginCents)}</td>
                <td className="text-right tabular-nums">{pct(r.marginRatePct)}</td>
              </tr>
            ))}
            {data && data.rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-muted-foreground">
                  Aucune vente sur cette sélection.
                </td>
              </tr>
            ) : null}
          </tbody>
          {data ? (
            <tfoot>
              <tr className="font-semibold">
                <td>Total</td>
                <td />
                <td className="text-right tabular-nums">{cents(data.total.ttcCents)}</td>
                <td className="text-right tabular-nums">{cents(data.total.htCents)}</td>
                <td className="text-right tabular-nums">{cents(data.total.costCents)}</td>
                <td className="text-right tabular-nums">{cents(data.total.marginCents)}</td>
                <td className="text-right tabular-nums">{pct(data.total.marginRatePct)}</td>
              </tr>
            </tfoot>
          ) : null}
        </Table>
      </Card>
    </div>
  );
}

function TrendPanel({ f }: { f: Filters }) {
  const params = new URLSearchParams({ from: f.from, to: f.to, granularity: f.granularity });
  const { data, error } = useQuery({
    queryKey: ['stats-trend', params.toString()],
    queryFn: () => api.get<Trend>(`/stats/trend?${params}`),
    placeholderData: (prev) => prev,
  });
  const points = data?.points ?? [];
  return (
    <div className="grid gap-3">
      {error ? <QueryError error={error} /> : null}
      <Card>
        <CardContent className="pt-6">
          {points.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune vente sur cette période.</p>
          ) : (
            <LineChart
              title="Chiffre d'affaires TTC par période, comparé à l'année précédente"
              currentLabel="Chiffre d'affaires"
              previousLabel="Même période, année précédente"
              points={points.map((p) => ({
                label: p.period,
                value: p.cents,
                previous: p.previousCents,
              }))}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <Table>
          <thead>
            <tr>
              <th>Période</th>
              <th className="text-right">CA TTC</th>
              <th className="text-right">N-1</th>
              <th className="text-right">Tickets</th>
              <th className="text-right">Panier moyen</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.period}>
                <td>{p.period}</td>
                <td className="text-right tabular-nums">{cents(p.cents)}</td>
                <td className="text-right tabular-nums text-muted-foreground">
                  {cents(p.previousCents)}
                </td>
                <td className="text-right tabular-nums">{p.tickets}</td>
                <td className="text-right tabular-nums">
                  {p.tickets ? cents(Math.round(p.cents / p.tickets)) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function TablePanel({ kind, f }: { kind: Exclude<Kind, 'sales' | 'trend'>; f: Filters }) {
  const params = new URLSearchParams({ from: f.from, to: f.to, granularity: f.granularity });
  if (kind === 'purchases' && f.supplierId) params.set('supplierId', f.supplierId);
  const { data, error, isFetching } = useQuery({
    queryKey: ['stats-report', kind, params.toString()],
    queryFn: () => api.get<ReportTableData>(`/stats/report/${kind}?${params}`),
    placeholderData: (prev) => prev,
  });
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <a className={cn(link)} href={`/api/v1/stats/report/${kind}?${params}&format=xlsx`}>
          <Download /> Exporter Excel
        </a>
      </div>
      {error ? <QueryError error={error} /> : null}
      {data ? <ReportTableView data={data} busy={isFetching} /> : null}
    </div>
  );
}

function SavedReports({ kind, f, onOpen }: { kind: Kind; f: Filters; onOpen: (s: Saved) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const { data } = useQuery({
    queryKey: ['saved-reports'],
    queryFn: () => api.get<Saved[]>('/stats/saved-reports'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['saved-reports'] });
  const save = useMutation({
    mutationFn: () =>
      api.post('/stats/saved-reports', {
        name,
        kind: kind === 'trend' ? 'sales' : kind,
        params: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')),
        shared,
      }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/stats/saved-reports/${id}`),
    onSuccess: refresh,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rapports enregistrés</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <Field label="Nom du rapport">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="flex h-10 items-center gap-2">
            <Checkbox
              id="saved-shared"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />
            <Label htmlFor="saved-shared" className="font-normal">
              Partagé avec l'équipe
            </Label>
          </div>
          <Button type="submit" variant="outline" disabled={!name.trim() || save.isPending}>
            <Bookmark /> Enregistrer ces filtres
          </Button>
        </form>
        {save.error ? <Alert>{save.error.message}</Alert> : null}
        <ul aria-label="Rapports enregistrés" className="grid gap-1">
          {(data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border p-2">
              <button
                type="button"
                className="flex-1 text-left font-medium hover:underline"
                onClick={() => onOpen(s)}
              >
                {s.name}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {KINDS.find((k) => k[0] === s.kind)?.[1]}
                  {s.shared ? ' · partagé' : ''}
                </span>
              </button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Supprimer ${s.name}`}
                onClick={() => remove.mutate(s.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
          {data?.length === 0 ? (
            <li className="text-muted-foreground">Aucun rapport enregistré.</li>
          ) : null}
        </ul>
      </CardContent>
    </Card>
  );
}

/** R-STA-03/05 — statistics: sales and margin, trend, payments, purchases, stock, households. */
export function StatsPage() {
  const today = todayIso();
  const [kind, setKind] = useState<Kind>('sales');
  const [f, setF] = useState<Filters>({
    from: `${today.slice(0, 8)}01`,
    to: today,
    by: 'product',
    granularity: 'month',
    supplierId: '',
    universeId: '',
    categoryId: '',
  });
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));
  const refs = useQuery({ queryKey: ['stats-refs'], queryFn: () => api.get<Refs>('/stats/refs') });
  const categories = (refs.data?.categories ?? []).filter(
    (c) => !f.universeId || c.universeId === f.universeId,
  );
  const sel = (label: string, value: string, onChange: (v: string) => void, options: Ref[]) => (
    <Field label={label}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Tous</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const needsGranularity = kind === 'trend' || kind === 'payments' || kind === 'purchases';

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Statistiques"
        description="Ventes, marge, tendances, achats et stock. Le coût des ventes utilise le prix d'achat HT en vigueur le jour de la vente (à défaut, le prix actuel)."
      />
      <div role="tablist" aria-label="Analyse" className="flex flex-wrap gap-1 border-b">
        {KINDS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              kind === k
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Du">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={f.from}
              onChange={(e) => set('from', e.target.value)}
            />
          )}
        </Field>
        <Field label="Au">
          {(p) => (
            <Input {...p} type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
          )}
        </Field>
        {kind === 'sales' ? (
          <>
            <Field label="Regrouper par">
              {(p) => (
                <Select
                  {...p}
                  value={f.by}
                  onChange={(e) => set('by', e.target.value as Filters['by'])}
                >
                  {GROUPS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {sel(
              'Univers',
              f.universeId,
              (v) => setF((x) => ({ ...x, universeId: v, categoryId: '' })),
              refs.data?.universes ?? [],
            )}
            {sel('Rayon', f.categoryId, (v) => set('categoryId', v), categories)}
          </>
        ) : null}
        {kind === 'sales' || kind === 'purchases'
          ? sel(
              'Fournisseur',
              f.supplierId,
              (v) => set('supplierId', v),
              refs.data?.suppliers ?? [],
            )
          : null}
        {needsGranularity ? (
          <Field label="Pas">
            {(p) => (
              <Select
                {...p}
                value={f.granularity}
                onChange={(e) => set('granularity', e.target.value as Filters['granularity'])}
              >
                {GRANULARITIES.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>
      {f.from > f.to ? <p className="text-sm text-destructive">La période est inversée.</p> : null}

      {f.from <= f.to ? (
        kind === 'sales' ? (
          <SalesPanel f={f} />
        ) : kind === 'trend' ? (
          <TrendPanel f={f} />
        ) : (
          <TablePanel kind={kind} f={f} />
        )
      ) : null}

      <SavedReports
        kind={kind}
        f={f}
        onOpen={(s) => {
          setKind(s.kind);
          setF((x) => ({ ...x, ...(s.params as Partial<Filters>) }));
        }}
      />
    </div>
  );
}
