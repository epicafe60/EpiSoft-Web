import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  formatQty,
  parseQtyToMilli,
  PRODUCT_STATUS_LABELS,
  supplierSchema,
  type SupplierInput,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { euro, formatDate } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import type { Commune } from '@/lib/types';
import { ORDER_STATUS_LABELS, type SupplierDetail, type SupplierRow } from '@/lib/types-supplies';
import { QueryError } from '../errors';

export function SuppliersPage() {
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const { data, error } = useQuery({
    queryKey: ['suppliers', q, onlyActive],
    queryFn: () =>
      api.get<SupplierRow[]>(
        `/suppliers?${new URLSearchParams({ ...(q ? { q } : {}), ...(onlyActive ? { active: 'true' } : {}) })}`,
      ),
    placeholderData: (prev) => prev,
  });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label="Rechercher un fournisseur"
          placeholder="Nom ou code…"
          className="max-w-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="active-only"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          <Label htmlFor="active-only" className="font-normal">
            Actifs seulement
          </Label>
        </div>
        <Link
          to="/appros/fournisseurs/nouveau"
          className={buttonVariants({ className: 'ml-auto' })}
        >
          <Plus /> Nouveau fournisseur
        </Link>
      </div>
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <th className="w-20">Code</th>
              <th>Fournisseur</th>
              <th className="hidden md:table-cell">Contact</th>
              <th className="text-right">Produits</th>
              <th className="text-right">À régler</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.id}>
                <td className="tabular-nums text-muted-foreground">{s.code}</td>
                <td>
                  <Link
                    to="/appros/fournisseurs/$id"
                    params={{ id: s.id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {s.name}
                  </Link>
                  {!s.active ? (
                    <Badge variant="muted" className="ml-2">
                      Inactif
                    </Badge>
                  ) : null}
                </td>
                <td className="hidden text-muted-foreground md:table-cell">
                  {s.contact} {s.email ? <span className="block text-xs">{s.email}</span> : null}
                </td>
                <td className="text-right tabular-nums">{s.products}</td>
                <td className="text-right tabular-nums">
                  {s.toPay !== '0.00' ? euro(s.toPay) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

const EMPTY: Required<Omit<SupplierInput, 'code' | 'region'>> & { code: string; region: string } = {
  code: '',
  region: '',
  name: '',
  contact: '',
  street: '',
  postcode: '',
  communeId: null,
  phone: '',
  email: '',
  website: '',
  priceListUrl: '',
  active: true,
  publicNotes: '',
  privateNotes: '',
  referentMemberId: null,
  sendsPo: true,
  accountNumber: '',
  minOrderAmount: null,
  paymentTermsDays: 30,
  deliveryDay: '',
};
type FormState = typeof EMPTY;

function toForm(s: SupplierDetail): FormState {
  return {
    code: s.code,
    region: s.code.slice(0, 2),
    name: s.name,
    contact: s.contact ?? '',
    street: s.street ?? '',
    postcode: s.postcode ?? '',
    communeId: s.communeId,
    phone: s.phone ?? '',
    email: s.email ?? '',
    website: s.website ?? '',
    priceListUrl: s.priceListUrl ?? '',
    active: s.active,
    publicNotes: s.publicNotes ?? '',
    privateNotes: s.privateNotes ?? '',
    referentMemberId: s.referentMemberId,
    sendsPo: s.sendsPo,
    accountNumber: s.accountNumber ?? '',
    minOrderAmount: s.minOrderAmount,
    paymentTermsDays: s.paymentTermsDays,
    deliveryDay: s.deliveryDay ?? '',
  };
}

export function NewSupplierPage() {
  return <SupplierForm supplier={null} />;
}

export function SupplierPage() {
  const { id } = useParams({ from: '/app/appros/fournisseurs/$id' });
  const { data, error } = useQuery({
    queryKey: ['supplier', id],
    queryFn: () => api.get<SupplierDetail>(`/suppliers/${id}`),
  });
  if (error) return <QueryError error={error} />;
  if (!data) return <p className="text-muted-foreground">Chargement…</p>;
  return <SupplierForm key={data.updatedAt} supplier={data} />;
}

/** R-FNR-01/02 (only the name is required) and R-FNR-03 (products, orders, invoices). */
function SupplierForm({ supplier }: { supplier: SupplierDetail | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [f, setF] = useState<FormState>(supplier ? toForm(supplier) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const communes = useQuery({
    queryKey: ['communes'],
    queryFn: () => api.get<Commune[]>('/communes'),
    staleTime: Infinity,
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const payload = () => {
    const { code, region, ...rest } = f;
    return {
      ...rest,
      minOrderAmount: f.minOrderAmount || null,
      ...(supplier
        ? code !== supplier.code
          ? { code }
          : {}
        : code
          ? { code }
          : { region: region || '99' }),
    };
  };
  const save = useMutation({
    mutationFn: () =>
      supplier
        ? api.patch<{ id: string }>(`/suppliers/${supplier.id}`, {
            ...payload(),
            updatedAt: supplier.updatedAt,
          })
        : api.post<{ id: string }>('/suppliers', payload()),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      await queryClient.invalidateQueries({ queryKey: ['supplier', r.id] });
      if (!supplier) void navigate({ to: '/appros/fournisseurs/$id', params: { id: r.id } });
    },
    onError: (e) => setErrors(e instanceof ApiError ? e.fieldErrors() : {}),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = supplierSchema.safeParse(payload());
    if (!parsed.success)
      return setErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])),
      );
    setErrors({});
    save.mutate();
  };
  const text = (k: keyof FormState, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label} error={errors[k]}>
      {(p) => (
        <Input
          {...p}
          {...props}
          value={(f[k] as string | null) ?? ''}
          onChange={(e) => set(k, e.target.value as never)}
        />
      )}
    </Field>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <form onSubmit={submit} className="grid content-start gap-4" noValidate>
        <h2 className="text-xl font-semibold">
          {supplier ? `${supplier.name} (${supplier.code})` : 'Nouveau fournisseur'}
        </h2>
        <Card>
          <CardContent className="grid gap-4 pt-5">
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem_8rem]">
              {text('name', 'Nom')}
              {supplier
                ? text('code', 'Code', { inputMode: 'numeric' })
                : text('region', 'Région (2 chiffres)', { inputMode: 'numeric', maxLength: 2 })}
              {text('accountNumber', 'Compte 401', { placeholder: 'automatique' })}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {text('contact', 'Contact')}
              {text('phone', 'Téléphone', { type: 'tel' })}
              {text('email', 'Courriel', { type: 'email' })}
              {text('website', 'Site web')}
            </div>
            {text('street', 'Adresse')}
            <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
              {text('postcode', 'Code postal', { inputMode: 'numeric', maxLength: 5 })}
              <Field label="Commune">
                {(p) => (
                  <Select
                    {...p}
                    value={f.communeId ?? ''}
                    onChange={(e) => set('communeId', e.target.value || null)}
                  >
                    <option value="">—</option>
                    {(communes.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.postcode})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {text('minOrderAmount', 'Minimum de commande (€ HT)', { inputMode: 'decimal' })}
              <Field label="Délai de paiement (jours)" error={errors.paymentTermsDays}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    value={String(f.paymentTermsDays)}
                    onChange={(e) =>
                      set('paymentTermsDays', Number(e.target.value.replace(/\D/g, '')) || 0)
                    }
                  />
                )}
              </Field>
              {text('deliveryDay', 'Jour de livraison')}
            </div>
            {text('priceListUrl', 'Lien vers les tarifs')}
            <div className="flex flex-wrap gap-6">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="s-active"
                  checked={f.active}
                  onChange={(e) => set('active', e.target.checked)}
                />
                <Label htmlFor="s-active" className="font-normal">
                  Actif
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="s-po"
                  checked={f.sendsPo}
                  onChange={(e) => set('sendsPo', e.target.checked)}
                />
                <Label htmlFor="s-po" className="font-normal">
                  Reçoit un bon de commande
                </Label>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Notes publiques">
                {(p) => (
                  <Textarea
                    {...p}
                    value={f.publicNotes ?? ''}
                    onChange={(e) => set('publicNotes', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Notes privées">
                {(p) => (
                  <Textarea
                    {...p}
                    value={f.privateNotes ?? ''}
                    onChange={(e) => set('privateNotes', e.target.value)}
                  />
                )}
              </Field>
            </div>
          </CardContent>
        </Card>
        {save.error && !Object.keys(errors).length ? <Alert>{save.error.message}</Alert> : null}
        {save.isSuccess && supplier ? <Alert variant="success">Fiche enregistrée.</Alert> : null}
        <div className="flex gap-3">
          <Button type="submit" disabled={save.isPending}>
            {supplier ? 'Enregistrer' : 'Créer le fournisseur'}
          </Button>
          <Link
            to="/appros/fournisseurs"
            className="inline-flex h-10 items-center px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            Retour à la liste
          </Link>
        </div>
      </form>

      {supplier ? (
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Commandes</CardTitle>
            </CardHeader>
            <Table>
              <tbody>
                {supplier.orders.slice(0, 10).map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link
                        to="/appros/commandes/$id"
                        params={{ id: o.id }}
                        className="text-primary hover:underline"
                      >
                        {o.number}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {ORDER_STATUS_LABELS[o.status]}
                      </span>
                    </td>
                    <td className="tabular-nums">{formatDate(o.date)}</td>
                    <td className="text-right tabular-nums">{euro(o.totalIncl)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Factures</CardTitle>
            </CardHeader>
            <Table>
              <tbody>
                {supplier.invoices.slice(0, 10).map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link
                        to="/appros/factures/$id"
                        params={{ id: i.id }}
                        className="text-primary hover:underline"
                      >
                        {i.pieceRef}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        échéance {formatDate(i.dueDate)}
                      </span>
                    </td>
                    <td>
                      {i.status === 'PAID' ? (
                        <Badge variant="success">Réglée</Badge>
                      ) : (
                        <Badge>À régler</Badge>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{euro(i.totalIncl)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Produits ({supplier.products.length})</CardTitle>
            </CardHeader>
            <Table>
              <tbody>
                {supplier.products.map((p) => (
                  <tr key={p.id} className={p.status === 'INACTIVE' ? 'text-muted-foreground' : ''}>
                    <td>
                      <Link to="/catalogue/$id" params={{ id: p.id }} className="hover:underline">
                        {p.name}
                      </Link>
                      {p.status !== 'ACTIVE' ? (
                        <span className="block text-xs">{PRODUCT_STATUS_LABELS[p.status]}</span>
                      ) : null}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatQty(parseQtyToMilli(p.stockQty) ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
