import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '@/lib/api';
import { euro, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { Card, Table } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { SortTh, useSort } from '@/components/ui/sortable';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';

const GROUPS = [
  ['product', 'Produit'],
  ['category', 'Rayon'],
  ['universe', 'Univers'],
  ['supplier', 'Fournisseur'],
  ['day', 'Jour'],
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

/** R-STA-03 — sales analysis with margin, filtered by period, supplier, universe, shelf. */
export function StatsPage() {
  const today = todayIso();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [by, setBy] = useState<(typeof GROUPS)[number][0]>('product');
  const [supplierId, setSupplierId] = useState('');
  const [universeId, setUniverseId] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const refs = useQuery({ queryKey: ['stats-refs'], queryFn: () => api.get<Refs>('/stats/refs') });
  const params = new URLSearchParams({ from, to, by });
  if (supplierId) params.set('supplierId', supplierId);
  if (universeId) params.set('universeId', universeId);
  if (categoryId) params.set('categoryId', categoryId);
  const { data, error, isFetching } = useQuery({
    queryKey: ['stats-analysis', params.toString()],
    queryFn: () => api.get<Analysis>(`/stats/analysis?${params}`),
    enabled: !!from && !!to && from <= to,
    placeholderData: (prev) => prev,
  });
  const sort = useSort(data?.rows, ACCESSORS);
  const categories = (refs.data?.categories ?? []).filter(
    (c) => !universeId || c.universeId === universeId,
  );
  const max = Math.max(1, ...(data?.rows ?? []).map((r) => Math.abs(r.htCents)));

  return (
    <div>
      <PageHeader
        title="Statistiques"
        description="Ventes et marge sur la période. Le coût utilise le prix d'achat HT actuel des produits."
        actions={
          <a
            className={cn(buttonVariants({ variant: 'outline' }))}
            href={`/api/v1/stats/analysis?${params}&format=xlsx`}
          >
            <Download /> Exporter Excel
          </a>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Du">
          {(p) => (
            <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          )}
        </Field>
        <Field label="Au">
          {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <Field label="Regrouper par">
          {(p) => (
            <Select {...p} value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
              {GROUPS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Univers">
          {(p) => (
            <Select
              {...p}
              value={universeId}
              onChange={(e) => {
                setUniverseId(e.target.value);
                setCategoryId('');
              }}
            >
              <option value="">Tous</option>
              {refs.data?.universes.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Rayon">
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Tous</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Fournisseur">
          {(p) => (
            <Select {...p} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Tous</option>
              {refs.data?.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {error ? <QueryError error={error} /> : null}
      {from > to ? <p className="text-sm text-destructive">La période est inversée.</p> : null}
      <Card aria-busy={isFetching}>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="label">
                {GROUPS.find((g) => g[0] === by)?.[1]}
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
