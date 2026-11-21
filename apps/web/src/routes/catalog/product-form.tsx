import { hasAnyRole, sellsBelowCost } from '@episoft/shared';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { useDeferredValue, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp } from 'lucide-react';
import {
  ALLERGEN_DECISION_LABELS,
  ALLERGEN_DECISIONS,
  ALLERGEN_LABELS,
  ALLERGENS,
  ORIGIN_FAMILIES,
  ORIGIN_FAMILY_LABELS,
  formatQty,
  parseQtyToMilli,
  pricePerKgOrLitreCents,
  PRODUCT_KIND_LABELS,
  PRODUCT_KINDS,
  PRODUCT_STATUS_LABELS,
  PRODUCT_STATUSES,
  productCreateSchema,
  parsePrice4,
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
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useSavedNotice, type SavedNotice } from '@/lib/saved-notice';
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
import {
  describeFieldErrors,
  EMPTY_PRODUCT_FORM as EMPTY,
  productToForm as toForm,
  productToPayload as toPayload,
  type ProductFormState as FormState,
} from './product-payload';

export function NewProductPage() {
  return <ProductForm product={null} />;
}

export function EditProductPage() {
  const notice = useSavedNotice();
  const { id } = useParams({ from: '/app/catalogue/$id' });
  const { data, error, isPending } = useQuery({
    queryKey: ['product', id],
    queryFn: () => api.get<ProductDetail>(`/products/${id}`),
  });
  if (isPending) return <p className="text-muted-foreground">Chargement…</p>;
  if (error) return <QueryError error={error} />;
  return <ProductForm key={data.updatedAt} product={data} notice={notice} />;
}

function ProductForm({ product, notice }: { product: ProductDetail | null; notice?: SavedNotice }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const readOnly = !hasAnyRole(useMe().roles, ['PRODUITS']);
  const [form, setForm] = useState<FormState>(product ? toForm(product) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refs = useQuery({
    queryKey: ['catalog-refs'],
    queryFn: () => api.get<CatalogRefs>('/catalog/refs'),
    staleTime: 60_000,
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  // A product with almost the same name may already exist: say so before it is created twice.
  const typedName = useDeferredValue(form.name.trim());
  const similar = useQuery({
    queryKey: ['similar-products', typedName, product?.id ?? ''],
    queryFn: () =>
      api.get<{ id: string; code: string; name: string; status: string }[]>(
        `/products/similar?${new URLSearchParams({ name: typedName, ...(product ? { exceptId: product.id } : {}) })}`,
      ),
    enabled: typedName.length >= 4 && (!product || typedName !== product.name),
  });

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
      notice?.mark();
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

  // PA TTC is whatever the team typed (R-PRD-04): it is only read here, for the margin.
  const incl4 = parsePrice4(form.purchasePriceIncl);
  const incl = incl4 !== null && incl4 > 0 ? incl4 / 10_000 : null;
  const sale = parseAmountToCents(form.salePrice);
  const perUnit =
    sale !== null && form.unit && form.kind !== 'SERVICE'
      ? pricePerKgOrLitreCents(
          sale,
          parseQtyToMilli(form.unitQty.replace(',', '.')) ?? 0,
          form.unit,
        )
      : null;
  const margin = sale && incl ? ((sale - Math.round(incl * 100)) / sale) * 100 : null;
  const belowCost = sale !== null && incl !== null && sellsBelowCost(sale, Math.round(incl * 100));

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

  const isService = form.kind === 'SERVICE';
  // A service has no quantity or unit to choose: its terms are shown, not asked.
  const fixed = (label: string, value: string) => (
    <Field label={label}>{(p) => <Input {...p} disabled readOnly value={value} />}</Field>
  );

  const universeName = (id: string) => refs.data?.universes.find((u) => u.id === id)?.name ?? '';

  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Produits', to: '/catalogue' },
          { label: product ? product.name : 'Nouveau produit' },
        ]}
      />
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
              {similar.data?.length ? (
                <Alert variant="info">
                  Un produit au nom très proche existe déjà :{' '}
                  {similar.data.map((s, i) => (
                    <span key={s.id}>
                      {i ? ', ' : ''}
                      <Link to="/catalogue/$id" params={{ id: s.id }} className="underline">
                        {s.name} ({s.code})
                      </Link>
                      {s.status === 'INACTIVE' ? ' — désactivé' : ''}
                    </span>
                  ))}
                  . Vérifiez que ce n’est pas un doublon.
                </Alert>
              ) : null}
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
              <div className="flex items-start gap-2">
                <Checkbox
                  id="shop-visible"
                  disabled={readOnly}
                  checked={form.shopVisible}
                  onChange={(e) => set('shopVisible', e.target.checked)}
                />
                <Label htmlFor="shop-visible" className="font-normal">
                  Visible dans la boutique en ligne
                  <span className="block text-xs text-muted-foreground">
                    Décochez pour masquer ce produit de la boutique, sans toucher à sa vente en
                    caisse. Un rayon entier se masque dans Produits › Rayons.
                  </span>
                </Label>
              </div>
            </CardContent>
          </Card>

          {!isService ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Information du consommateur</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="is-food"
                    disabled={readOnly}
                    checked={form.isFood}
                    onChange={(e) => set('isFood', e.target.checked)}
                  />
                  <Label htmlFor="is-food" className="font-normal">
                    Produit alimentaire
                    <span className="block text-xs text-muted-foreground">
                      Allergènes, ingrédients et quantité nette obligatoires (règlement UE
                      1169/2011) ; le lot et la date limite sont demandés à la réception.
                    </span>
                  </Label>
                </div>
                {form.isFood ? (
                  <>
                    <fieldset className="grid gap-2" aria-describedby="allergens-hint">
                      <legend className="mb-1 text-sm font-medium">Allergènes</legend>
                      <p id="allergens-hint" className="text-xs text-muted-foreground">
                        Le choix est obligatoire : « Aucun allergène déclaré » se choisit, il n’est
                        pas la valeur par défaut.
                      </p>
                      <div className="flex flex-wrap gap-4">
                        {ALLERGEN_DECISIONS.map((d) => (
                          <div key={d} className="flex items-center gap-2">
                            <input
                              type="radio"
                              id={`ad-${d}`}
                              name="allergens-decision"
                              disabled={readOnly}
                              checked={form.allergensDecision === d}
                              onChange={() =>
                                setForm((f) => ({
                                  ...f,
                                  allergensDecision: d,
                                  allergens: d === 'NONE' ? [] : f.allergens,
                                }))
                              }
                            />
                            <Label htmlFor={`ad-${d}`} className="font-normal">
                              {ALLERGEN_DECISION_LABELS[d]}
                            </Label>
                          </div>
                        ))}
                      </div>
                      {errors.allergensDecision ? (
                        <p role="alert" className="text-sm text-destructive">
                          {errors.allergensDecision}
                        </p>
                      ) : null}
                      {form.allergensDecision === 'LISTED' ? (
                        <div className="grid gap-1 sm:grid-cols-2">
                          {ALLERGENS.map((a) => (
                            <div key={a} className="flex items-center gap-2">
                              <Checkbox
                                id={`al-${a}`}
                                disabled={readOnly}
                                checked={form.allergens.includes(a)}
                                onChange={(e) =>
                                  set(
                                    'allergens',
                                    e.target.checked
                                      ? [...form.allergens, a]
                                      : form.allergens.filter((x) => x !== a),
                                  )
                                }
                              />
                              <Label htmlFor={`al-${a}`} className="font-normal">
                                {ALLERGEN_LABELS[a]}
                              </Label>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {errors.allergens ? (
                        <p role="alert" className="text-sm text-destructive">
                          {errors.allergens}
                        </p>
                      ) : null}
                    </fieldset>
                    <details className="rounded border p-3">
                      <summary className="cursor-pointer text-sm font-medium">
                        Peut contenir des traces de ({form.allergenTraces.length})
                      </summary>
                      <div className="mt-2 grid gap-1 sm:grid-cols-2">
                        {ALLERGENS.map((a) => (
                          <div key={a} className="flex items-center gap-2">
                            <Checkbox
                              id={`tr-${a}`}
                              disabled={readOnly}
                              checked={form.allergenTraces.includes(a)}
                              onChange={(e) =>
                                set(
                                  'allergenTraces',
                                  e.target.checked
                                    ? [...form.allergenTraces, a]
                                    : form.allergenTraces.filter((x) => x !== a),
                                )
                              }
                            />
                            <Label htmlFor={`tr-${a}`} className="font-normal">
                              {ALLERGEN_LABELS[a]}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </details>
                    <Field
                      label="Ingrédients"
                      error={errors.ingredients}
                      hint="Dans l’ordre de l’emballage. Un seul ingrédient : son nom."
                    >
                      {(p) => (
                        <Textarea
                          {...p}
                          disabled={readOnly}
                          value={form.ingredients}
                          onChange={(e) => set('ingredients', e.target.value)}
                        />
                      )}
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {select(
                        'originFamily',
                        'Origine obligatoire pour',
                        ORIGIN_FAMILIES.map((f) => [f, ORIGIN_FAMILY_LABELS[f]]),
                        true,
                      )}
                      {text(
                        'origin',
                        'Origine (pays ou région)',
                        {},
                        'Obligatoire pour les fruits et légumes, le miel, la viande, le poisson, les œufs…',
                      )}
                    </div>
                  </>
                ) : null}
                {form.qualities.includes('LOCAL') ? (
                  <Field
                    label="Pourquoi « local » ?"
                    error={errors.localJustification}
                    hint="Producteur et distance ou lieu, par exemple « Ferme Durand, Montjavoult, 5 km »."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        disabled={readOnly}
                        value={form.localJustification}
                        onChange={(e) => set('localJustification', e.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
                {form.qualities.includes('ORGANIC') ? (
                  <p className="text-sm text-muted-foreground">
                    « Bio » exige un certificat bio valide sur la fiche du fournisseur (numéro,
                    organisme, date de fin de validité).
                    {product && product.organic !== 'VALID' ? (
                      <span className="text-destructive">
                        {' '}
                        Ce n’est pas le cas aujourd’hui : la mention est refusée.
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {errors.qualities ? (
                  <p role="alert" className="text-sm text-destructive">
                    {errors.qualities}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Vente et prix</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-3">
                {isService ? (
                  <>
                    {fixed('Vente', SALE_MODE_LABELS.UNIT)}
                    {fixed('Quantité unitaire', '1')}
                    {fixed('Unité', '€')}
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
              {isService ? (
                <p className="text-sm text-muted-foreground">
                  Un service (adhésion, don…) se vend à l’unité : la quantité est toujours 1 et le
                  montant est en euros, sans unité de poids ni de volume.
                </p>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-3">
                {text('purchasePriceExcl', 'PA HT (€)', { inputMode: 'decimal' })}
                {text('purchaseVatAmount', 'Montant de TVA (€)', { inputMode: 'decimal' })}
                {text('purchasePriceIncl', 'PA TTC (€)', { inputMode: 'decimal' })}
              </div>
              <p className="text-sm text-muted-foreground">
                Ces trois montants se saisissent à la main : l’application ne les calcule pas et ne
                les compare pas entre eux.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                {select(
                  'vatRate',
                  'Taux de TVA',
                  VAT_RATES.map((v) => [v, `${Number(v).toLocaleString('fr-FR')} %`]),
                )}
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
              {errors.salePrice && /revente à perte/.test(errors.salePrice) ? (
                <div className="grid gap-2">
                  {text(
                    'belowCostReason',
                    'Motif de vente sous le prix d’achat',
                    {},
                    'Exception exceptionnelle (produit périssable menacé, fin de série) : le motif est conservé dans le journal.',
                  )}
                </div>
              ) : null}
              {belowCost ? (
                <Alert>
                  Le prix de vente est inférieur au prix d’achat TTC : chaque vente fera perdre de
                  l’argent. Vérifiez les deux prix.
                </Alert>
              ) : null}
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
          {notice?.saved && product ? <Alert variant="success">Produit enregistré.</Alert> : null}
          {Object.keys(errors).length ? (
            <Alert>
              Certaines valeurs sont invalides :
              <ul className="mt-1 list-disc pl-5">
                {describeFieldErrors(errors).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <div className="flex gap-3">
            {!readOnly ? (
              <Button type="submit" disabled={save.isPending}>
                {product ? 'Enregistrer' : 'Créer le produit'}
              </Button>
            ) : null}
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
              <Table exportable={false}>
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
