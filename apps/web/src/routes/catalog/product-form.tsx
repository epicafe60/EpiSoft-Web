import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp } from 'lucide-react';
import {
  formatQty,
  parseQtyToMilli,
  pricePerKgOrLitreCents,
  PRODUCT_KIND_LABELS,
  PRODUCT_KINDS,
  PRODUCT_STATUS_LABELS,
  PRODUCT_STATUSES,
  productCreateSchema,
  purchasePriceIncl,
  QUALITIES,
  QUALITY_LABELS,
  SALE_CONDITION_LABELS,
  SALE_CONDITIONS,
  SALE_MODE_LABELS,
  SALE_MODES,
  UNIT_LABELS,
  UNITS,
  VAT_RATES,
  centsToDecimal,
  parseAmountToCents,
  type ProductCreate,
  type ProductKind,
  type ProductStatus,
  type Quality,
  type SaleCondition,
  type SaleMode,
  type Unit,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { euro } from '@/lib/format';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import type { CatalogRefs, ProductDetail } from '@/lib/types';
import { PageHeader } from '../shell';
import { QueryError } from '../errors';
import { StockHistoryCard } from './tools';

interface FormState {
  code: string;
  name: string;
  description: string;
  kind: ProductKind;
  saleMode: SaleMode;
  unitQty: string;
  unit: Unit | '';
  saleCondition: SaleCondition;
  categoryId: string;
  supplierId: string;
  supplierRef: string;
  qualities: Quality[];
  vatRate: string;
  status: ProductStatus;
  purchasePriceExcl: string;
  salePrice: string;
  minStock: string;
  eans: string;
  posTabId: string;
  posLabel: string;
  posSort: string;
}

const EMPTY: FormState = {
  code: '',
  name: '',
  description: '',
  kind: 'GOODS',
  saleMode: 'UNIT',
  unitQty: '',
  unit: '',
  saleCondition: 'ON_SITE',
  categoryId: '',
  supplierId: '',
  supplierRef: '',
  qualities: [],
  vatRate: '5.50',
  status: 'ACTIVE',
  purchasePriceExcl: '',
  salePrice: '',
  minStock: '',
  eans: '',
  posTabId: '',
  posLabel: '',
  posSort: '0',
};

const dec = (v: string | null) =>
  v === null ? '' : v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

function toForm(p: ProductDetail): FormState {
  return {
    code: p.code,
    name: p.name,
    description: p.description ?? '',
    kind: p.kind,
    saleMode: p.saleMode,
    unitQty: dec(p.unitQty),
    unit: p.unit ?? '',
    saleCondition: p.saleCondition,
    categoryId: p.categoryId ?? '',
    supplierId: p.supplierId ?? '',
    supplierRef: p.supplierRef ?? '',
    qualities: p.qualities,
    vatRate: p.vatRate,
    status: p.status,
    purchasePriceExcl: p.purchasePriceExcl ? Number(p.purchasePriceExcl).toFixed(2) : '',
    salePrice: p.salePrice,
    minStock: dec(p.minStock),
    eans: p.eans.join(' '),
    posTabId: p.posTabId ?? '',
    posLabel: p.posLabel ?? '',
    posSort: String(p.posSort),
  };
}

function toPayload(f: FormState): ProductCreate {
  return {
    name: f.name,
    description: f.description,
    kind: f.kind,
    saleMode: f.saleMode,
    unitQty: f.unitQty || null,
    unit: f.unit || null,
    saleCondition: f.saleCondition,
    categoryId: f.categoryId || null,
    supplierId: f.supplierId || null,
    supplierRef: f.supplierRef,
    qualities: f.qualities,
    vatRate: f.vatRate as ProductCreate['vatRate'],
    status: f.status,
    purchasePriceExcl: f.purchasePriceExcl || null,
    salePrice: f.salePrice,
    minStock: f.minStock || null,
    eans: f.eans.split(/[\s,;]+/).filter(Boolean),
    posTabId: f.posTabId || null,
    posLabel: f.posLabel,
    posSort: Number(f.posSort) || 0,
    ...(f.code ? { code: f.code } : {}),
  };
}

export function NewProductPage() {
  return <ProductForm product={null} />;
}

export function EditProductPage() {
  const { id } = useParams({ from: '/app/catalogue/$id' });
  const { data, error, isPending } = useQuery({
    queryKey: ['product', id],
    queryFn: () => api.get<ProductDetail>(`/products/${id}`),
  });
  if (isPending) return <p className="text-muted-foreground">Chargement…</p>;
  if (error) return <QueryError error={error} />;
  return <ProductForm key={data.updatedAt} product={data} />;
}

function ProductForm({ product }: { product: ProductDetail | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const readOnly = !useMe().roles.includes('PRODUITS');
  const [form, setForm] = useState<FormState>(product ? toForm(product) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refs = useQuery({
    queryKey: ['catalog-refs'],
    queryFn: () => api.get<CatalogRefs>('/catalog/refs'),
    staleTime: 60_000,
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // R-PRD-01: the code is proposed from the shelf for a new product.
  const nextCode = useQuery({
    queryKey: ['next-code', form.categoryId],
    queryFn: () => api.get<{ code: string }>(`/products/next-code?categoryId=${form.categoryId}`),
    enabled: !product && !!form.categoryId && !readOnly,
  });
  useEffect(() => {
    if (!product && nextCode.data) setForm((f) => ({ ...f, code: nextCode.data.code }));
  }, [nextCode.data, product]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = toPayload(form);
      if (!product) return api.post<{ id: string }>('/products', payload);
      // Only the fields that changed are sent.
      const initial = toPayload(toForm(product));
      const changed = Object.fromEntries(
        Object.entries(payload).filter(
          ([k, v]) => JSON.stringify(v) !== JSON.stringify((initial as Record<string, unknown>)[k]),
        ),
      );
      return api.patch<{ id: string }>(`/products/${product.id}`, {
        ...changed,
        updatedAt: product.updatedAt,
      });
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await queryClient.invalidateQueries({ queryKey: ['product', res.id] });
      if (!product) void navigate({ to: '/catalogue/$id', params: { id: res.id } });
    },
    onError: (e) => setErrors(e instanceof ApiError ? e.fieldErrors() : {}),
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.upload(`/products/${product!.id}/image`, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['product', product!.id] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = productCreateSchema.safeParse(toPayload(form));
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate();
  };

  const excl = parseAmountToCents(form.purchasePriceExcl);
  const incl = excl !== null ? purchasePriceIncl(centsToDecimal(excl), form.vatRate) : null;
  const sale = parseAmountToCents(form.salePrice);
  const perUnit =
    sale !== null && form.unit
      ? pricePerKgOrLitreCents(
          sale,
          parseQtyToMilli(form.unitQty.replace(',', '.')) ?? 0,
          form.unit,
        )
      : null;
  const margin = sale && incl ? ((sale - Math.round(Number(incl) * 100)) / sale) * 100 : null;

  const text = (
    k: keyof FormState,
    label: string,
    props: Record<string, unknown> = {},
    hint?: string,
  ) => (
    <Field label={label} error={errors[k]} {...(hint ? { hint } : {})}>
      {(p) => (
        <Input
          {...p}
          {...props}
          disabled={readOnly}
          value={form[k] as string}
          onChange={(e) => set(k, e.target.value as never)}
        />
      )}
    </Field>
  );
  const select = <K extends keyof FormState>(
    k: K,
    label: string,
    options: [string, string][],
    allowEmpty = false,
  ) => (
    <Field label={label} error={errors[k]}>
      {(p) => (
        <Select
          {...p}
          disabled={readOnly}
          value={form[k] as string}
          onChange={(e) => set(k, e.target.value as FormState[K])}
        >
          {allowEmpty ? <option value="">—</option> : null}
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  const universeName = (id: string) => refs.data?.universes.find((u) => u.id === id)?.name ?? '';

  return (
    <>
      <PageHeader
        title={product ? product.name : 'Nouveau produit'}
        description={
          product
            ? `Code ${product.code} · stock ${formatQty(parseQtyToMilli(product.stockQty) ?? 0)}`
            : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <form onSubmit={submit} className="grid content-start gap-6" noValidate>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Description</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {text('name', 'Nom')}
              <Field label="Description" error={errors.description}>
                {(p) => (
                  <Textarea
                    {...p}
                    disabled={readOnly}
                    value={form.description}
                    onChange={(e) => set('description', e.target.value)}
                  />
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                {select(
                  'kind',
                  'Type',
                  PRODUCT_KINDS.map((k) => [k, PRODUCT_KIND_LABELS[k]]),
                )}
                {select(
                  'status',
                  'Statut',
                  PRODUCT_STATUSES.map((s) => [s, PRODUCT_STATUS_LABELS[s]]),
                )}
                {select(
                  'saleCondition',
                  'Condition de vente',
                  SALE_CONDITIONS.map((s) => [s, SALE_CONDITION_LABELS[s]]),
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {select(
                  'categoryId',
                  'Rayon',
                  (refs.data?.categories ?? []).map((c) => [
                    c.id,
                    `${universeName(c.universeId)} › ${c.name}`,
                  ]),
                  true,
                )}
                {text(
                  'code',
                  'Code',
                  { inputMode: 'numeric', disabled: readOnly || product?.hasSales },
                  product?.hasSales ? 'Non modifiable : produit déjà vendu.' : undefined,
                )}
                {text(
                  'eans',
                  'Codes-barres',
                  { inputMode: 'numeric' },
                  'Plusieurs codes séparés par un espace.',
                )}
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Qualités</legend>
                <div className="flex flex-wrap gap-4">
                  {QUALITIES.map((q) => (
                    <div key={q} className="flex items-center gap-2">
                      <Checkbox
                        id={`q-${q}`}
                        disabled={readOnly}
                        checked={form.qualities.includes(q)}
                        onChange={(e) =>
                          set(
                            'qualities',
                            e.target.checked
                              ? [...form.qualities, q]
                              : form.qualities.filter((x) => x !== q),
                          )
                        }
                      />
                      <Label htmlFor={`q-${q}`} className="font-normal">
                        {QUALITY_LABELS[q]}
                      </Label>
                    </div>
                  ))}
                </div>
              </fieldset>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Vente et prix</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-3">
                {select(
                  'saleMode',
                  'Vente',
                  SALE_MODES.map((m) => [m, SALE_MODE_LABELS[m]]),
                )}
                {text('unitQty', 'Quantité unitaire', { inputMode: 'decimal' })}
                {select(
                  'unit',
                  'Unité',
                  UNITS.map((u) => [u, UNIT_LABELS[u]]),
                  true,
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-4">
                {text('purchasePriceExcl', 'PA HT (€)', { inputMode: 'decimal' })}
                {select(
                  'vatRate',
                  'TVA',
                  VAT_RATES.map((v) => [v, `${Number(v).toLocaleString('fr-FR')} %`]),
                )}
                <Field label="PA TTC (€)">
                  {(p) => (
                    <Input
                      {...p}
                      disabled
                      value={incl ? Number(incl).toFixed(4).replace('.', ',') : ''}
                    />
                  )}
                </Field>
                {text('salePrice', 'Prix de vente TTC (€)', { inputMode: 'decimal' })}
              </div>
              <p className="text-sm text-muted-foreground">
                {perUnit !== null
                  ? `Prix au ${form.unit === 'G' || form.unit === 'KG' ? 'kg' : 'litre'} : ${euro(centsToDecimal(perUnit))}. `
                  : ''}
                {margin !== null
                  ? `Taux de marque : ${margin.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % (Q2, définition à valider).`
                  : ''}
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                {text('minStock', 'Stock minimum', { inputMode: 'decimal' })}
                {select(
                  'supplierId',
                  'Fournisseur',
                  (refs.data?.suppliers ?? []).map((s) => [s.id, `${s.name} (${s.code})`]),
                  true,
                )}
                {text('supplierRef', 'Réf. fournisseur')}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bouton de caisse</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              {select(
                'posTabId',
                'Onglet',
                (refs.data?.posTabs ?? []).map((t) => [t.id, t.name]),
                true,
              )}
              {text('posLabel', 'Libellé du bouton')}
              {text('posSort', 'Ordre', { inputMode: 'numeric' })}
            </CardContent>
          </Card>

          {save.error && !Object.keys(errors).length ? <Alert>{save.error.message}</Alert> : null}
          {save.isSuccess && product ? <Alert variant="success">Produit enregistré.</Alert> : null}
          {Object.keys(errors).length ? <Alert>Certaines valeurs sont invalides.</Alert> : null}
          <div className="flex gap-3">
            {!readOnly ? (
              <Button type="submit" disabled={save.isPending}>
                {product ? 'Enregistrer' : 'Créer le produit'}
              </Button>
            ) : null}
            <Link
              to="/catalogue"
              className="inline-flex h-10 items-center px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              Retour au catalogue
            </Link>
          </div>
        </form>

        {product ? (
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Image</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {product.imageId ? (
                  <img
                    src={`/api/v1/media/${product.imageId}`}
                    alt={product.name}
                    className="mx-auto max-h-40 rounded"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Pas d’image.</p>
                )}
                {!readOnly ? (
                  <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-input px-4 text-sm font-medium hover:bg-accent">
                    <ImageUp className="size-4" /> Choisir une image
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) upload.mutate(f);
                      }}
                    />
                  </label>
                ) : null}
                {upload.error ? <Alert>{upload.error.message}</Alert> : null}
              </CardContent>
            </Card>
            {product.kind === 'GOODS' ? (
              <StockHistoryCard productId={product.id} canCorrect={!readOnly} />
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Historique des prix</CardTitle>
              </CardHeader>
              <Table>
                <tbody>
                  {product.priceHistory.map((h) => (
                    <tr key={h.id}>
                      <td className="text-xs tabular-nums">{formatDateTime(h.at)}</td>
                      <td className="text-right tabular-nums">{euro(h.salePrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
