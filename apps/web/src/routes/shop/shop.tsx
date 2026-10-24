import { useDeferredValue, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Minus, Plus, ShoppingBasket, Trash2 } from 'lucide-react';
import {
  hasAnyRole,
  PREORDER_STATUS_LABELS,
  UNIT_LABELS,
  cartTotalCents,
  decimalToCents,
  formatQty,
  memberCanCancel,
  parseQtyToMilli,
  type PreorderStatus,
  type Unit,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { confirmNow } from '@/components/confirm';
import { useMe } from '@/lib/auth';
import type { MemberListItem } from '@/lib/types';
import { euro, formatDate, todayIso } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';
import { useCart, type CartLine } from './cart';
import { useFavorites } from './favorites';
import { RatingButton, type Ratings } from './reviews';

interface ShopProduct {
  id: string;
  name: string;
  description: string | null;
  salePrice: string;
  saleMode: 'UNIT' | 'WEIGHT' | 'VOLUME';
  unit: Unit | null;
  categoryId: string | null;
  categoryName: string | null;
  imageId: string | null;
}

export interface MyOrder {
  id: string;
  number: string;
  status: PreorderStatus;
  pickupDate: string;
  comment: string | null;
  totalCents: number;
  lines: { id: string; productId: string; label: string; qty: string; unitPrice: string }[];
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const NO_SHELF = 'none';

/** The customer's shop window and cart (R-PRE-01). */
export function ShopPage() {
  const me = useMe();
  if (me.shopEnabled === false)
    return (
      <>
        <PageHeader title="Boutique" />
        <Alert variant="info">
          La boutique en ligne est fermée pour le moment. Revenez plus tard, ou passez à l’épicerie.
        </Alert>
      </>
    );
  return <ShopContent />;
}

function ShopContent() {
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const { data, error, isPending } = useQuery({
    queryKey: ['shop-products', query],
    queryFn: () =>
      api.get<ShopProduct[]>(
        `/shop/products${query ? `?${new URLSearchParams({ q: query })}` : ''}`,
      ),
    placeholderData: (prev) => prev,
  });
  // Shelves offered by the filter come from the whole window, whatever is typed in the search.
  const all = useQuery({
    queryKey: ['shop-products', ''],
    queryFn: () => api.get<ShopProduct[]>('/shop/products'),
  });
  const [shelf, setShelf] = useState('');
  const shelves = new Map<string, string>();
  for (const p of all.data ?? [])
    shelves.set(p.categoryId ?? NO_SHELF, p.categoryName ?? 'Autres produits');
  const inShelf = (p: ShopProduct) => !shelf || (p.categoryId ?? NO_SHELF) === shelf;
  const favorites = useFavorites();
  const favoriteProducts = (data ?? []).filter((p) => favorites.has(p.id) && inShelf(p));
  const groups = new Map<string, ShopProduct[]>();
  // A favourite is shown once, in "Mes favoris", not again in its shelf.
  for (const p of (data ?? []).filter((x) => !favorites.has(x.id) && inShelf(x))) {
    const k = p.categoryName ?? 'Autres produits';
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  return (
    <>
      <PageHeader
        title="Boutique"
        description="Composez votre panier : vous réglez au retrait, à l’épicerie."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-4">
          <div className="flex flex-wrap gap-3">
            <Input
              type="search"
              aria-label="Rechercher un produit"
              placeholder="Rechercher un produit…"
              className="w-full sm:max-w-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {shelves.size > 1 ? (
              <Select
                aria-label="Rayon"
                className="w-full sm:w-56"
                value={shelf}
                onChange={(e) => setShelf(e.target.value)}
              >
                <option value="">Tous les rayons</option>
                {[...shelves.entries()]
                  .sort(([, a], [, b]) => a.localeCompare(b, 'fr'))
                  .map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </Select>
            ) : null}
          </div>
          {error ? <QueryError error={error} /> : null}
          {isPending ? <p className="text-sm text-muted-foreground">Chargement…</p> : null}
          {data?.length === 0 ? (
            <Alert variant="info">Aucun produit n’est proposé à la commande pour l’instant.</Alert>
          ) : null}
          {data?.length && !favoriteProducts.length && !groups.size ? (
            <Alert variant="info">Aucun produit dans ce rayon.</Alert>
          ) : null}
          {favoriteProducts.length ? (
            <section aria-label="Mes favoris" className="grid gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                <Heart className="size-4 fill-current text-destructive" aria-hidden /> Mes favoris
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {favoriteProducts.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </section>
          ) : null}
          {[...groups.entries()].map(([name, products]) => (
            <section key={name} aria-label={name} className="grid gap-2">
              <h2 className="text-sm font-semibold text-muted-foreground">{name}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {products.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <CartPanel />
        </aside>
      </div>
      <MyOrders />
    </>
  );
}

function ProductCard({ product: p }: { product: ShopProduct }) {
  const cart = useCart();
  const loose = p.saleMode !== 'UNIT';
  const [qty, setQty] = useState(loose ? '0,5' : '1');
  const unit = loose && p.unit ? UNIT_LABELS[p.unit] : null;
  const inCart = cart.lines.find((l) => l.productId === p.id);
  const favorites = useFavorites();
  const fav = favorites.has(p.id);
  const { data: ratings } = useQuery({
    queryKey: ['shop-ratings'],
    queryFn: () => api.get<Ratings>('/shop/ratings'),
    staleTime: 60_000,
  });
  return (
    <Card className="flex flex-col">
      <CardContent className="grid flex-1 gap-2 pt-4">
        <div className="flex gap-3">
          {p.imageId ? (
            <img
              src={`/api/v1/media/${p.imageId}`}
              alt=""
              loading="lazy"
              className="size-16 shrink-0 rounded object-cover"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="font-medium leading-tight">{p.name}</p>
            <p className="text-sm text-muted-foreground">
              {euro(p.salePrice)}
              {unit ? ` / ${unit}` : ''}
            </p>
          </div>
          <button
            type="button"
            aria-pressed={fav}
            aria-label={fav ? `Retirer ${p.name} des favoris` : `Mettre ${p.name} en favori`}
            title={fav ? 'Retirer des favoris' : 'Mettre en favori'}
            onClick={() => favorites.toggle(p.id)}
            className="-m-1 h-fit shrink-0 rounded-full p-2 text-muted-foreground hover:text-destructive focus-visible:outline-2"
          >
            <Heart
              className={fav ? 'size-5 fill-current text-destructive' : 'size-5'}
              aria-hidden
            />
          </button>
        </div>
        {p.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
        ) : null}
        <RatingButton productId={p.id} name={p.name} rating={ratings?.[p.id]} />
        <div className="mt-auto flex items-center gap-2">
          <Input
            aria-label={`Quantité de ${p.name}`}
            inputMode="decimal"
            className="w-20"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
          <Button
            size="sm"
            className="ml-auto"
            disabled={(parseQtyToMilli(qty) ?? 0) <= 0}
            onClick={() =>
              cart.add(
                {
                  productId: p.id,
                  name: p.name,
                  unitPriceCents: decimalToCents(p.salePrice),
                  unit,
                },
                qty,
              )
            }
          >
            <Plus /> Ajouter
          </Button>
        </div>
        {inCart ? (
          <p className="text-xs text-green-700">
            Dans le panier : {formatQty(parseQtyToMilli(inCart.qty) ?? 0)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CartPanel() {
  const cart = useCart();
  const me = useMe();
  const canOrderFor =
    hasAnyRole(me.roles, ['ADHERENTS']) &&
    hasAnyRole(me.roles, ['COMMANDES_EN_LIGNE', 'COMMANDES_GESTION']);
  const [forMember, setForMember] = useState<{ id: string; label: string } | null>(null);
  const [memberQ, setMemberQ] = useState('');
  const search = useQuery({
    queryKey: ['shop-member-search', memberQ],
    queryFn: () =>
      api.get<MemberListItem[]>(`/members?${new URLSearchParams({ q: memberQ, limit: '6' })}`),
    enabled: canOrderFor && memberQ.trim().length >= 2,
  });
  const queryClient = useQueryClient();
  const [pickupDate, setPickupDate] = useState(() => addDays(todayIso(), 3));
  const [comment, setComment] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const total = cartTotalCents(cart.lines);
  const submit = useMutation({
    mutationFn: () =>
      api.post<{ id: string; number: string }>('/preorders', {
        pickupDate,
        memberId: forMember?.id,
        comment: comment || undefined,
        lines: cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      }),
    onSuccess: async (r) => {
      setDone(r.number);
      cart.clear();
      setForMember(null);
      setMemberQ('');
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['my-orders'] });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShoppingBasket className="size-4" /> Mon panier
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {done ? (
          <Alert variant="success">
            Votre commande {done} est enregistrée. Vous la réglerez au retrait.
          </Alert>
        ) : null}
        {cart.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Votre panier est vide.</p>
        ) : (
          <ul className="grid gap-2" aria-label="Lignes du panier">
            {cart.lines.map((l) => (
              <CartRow key={l.productId} line={l} />
            ))}
          </ul>
        )}
        {cart.lines.length > 0 ? (
          <>
            <p className="flex justify-between border-t pt-2 font-medium">
              <span>Total estimé</span>
              <span className="tabular-nums">{euro(total / 100)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Prix indicatifs : le montant final est celui du jour, en caisse.
            </p>
            {canOrderFor ? (
              <div className="grid gap-1">
                <Field label="Commande pour un adhérent (facultatif)">
                  {(p) => (
                    <Input
                      {...p}
                      type="search"
                      placeholder="Nom ou n° d’adhérent…"
                      value={forMember ? forMember.label : memberQ}
                      onChange={(e) => {
                        setForMember(null);
                        setMemberQ(e.target.value);
                      }}
                    />
                  )}
                </Field>
                {!forMember && search.data?.length ? (
                  <ul className="rounded-md border text-sm">
                    {search.data.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-1.5 text-left hover:bg-accent"
                          onClick={() =>
                            setForMember({
                              id: m.id,
                              label: `${m.lastName} ${m.firstName} (n° ${m.number})`,
                            })
                          }
                        >
                          {m.lastName} {m.firstName} · n° {m.number}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {forMember ? (
                  <p className="text-xs text-muted-foreground">
                    La commande sera au nom de cet adhérent.
                  </p>
                ) : null}
              </div>
            ) : null}
            <Field label="Date de retrait souhaitée">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  min={todayIso()}
                  value={pickupDate}
                  onChange={(e) => setPickupDate(e.target.value)}
                />
              )}
            </Field>
            <Field label="Message pour l’équipe (facultatif)">
              {(p) => (
                <Textarea
                  {...p}
                  maxLength={300}
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              )}
            </Field>
            {submit.error ? <Alert>{submit.error.message}</Alert> : null}
            <Button onClick={() => submit.mutate()} disabled={submit.isPending || !pickupDate}>
              Valider ma commande
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CartRow({ line }: { line: CartLine }) {
  const cart = useCart();
  const milli = parseQtyToMilli(line.qty) ?? 0;
  const step = line.unit ? 250 : 1000;
  const set = (m: number) => cart.setQty(line.productId, (m / 1000).toFixed(3));
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate" title={line.name}>
        {line.name}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="size-7"
        aria-label={`Retirer une unité de ${line.name}`}
        onClick={() => set(milli - step)}
      >
        <Minus />
      </Button>
      <span className="w-14 text-center tabular-nums">
        {formatQty(milli)}
        {line.unit ? ` ${line.unit}` : ''}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="size-7"
        aria-label={`Ajouter une unité de ${line.name}`}
        onClick={() => set(milli + step)}
      >
        <Plus />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={`Supprimer ${line.name} du panier`}
        onClick={() => cart.remove(line.productId)}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

const STATUS_BADGE: Record<PreorderStatus, 'default' | 'success' | 'muted' | 'destructive'> = {
  SUBMITTED: 'default',
  READY: 'success',
  PICKED_UP: 'muted',
  CANCELLED: 'destructive',
};

export function MyOrders() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['my-orders'],
    queryFn: () => api.get<MyOrder[]>('/preorders/mine'),
  });
  const cart = useCart();
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/preorders/${id}/status`, { status: 'CANCELLED' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-orders'] }),
  });
  if (error) return <QueryError error={error} />;
  if (!data?.length) return null;
  return (
    <section className="mt-8 grid gap-3" aria-label="Mes commandes">
      <h2 className="text-lg font-semibold">Mes commandes</h2>
      {cancel.error ? <Alert>{cancel.error.message}</Alert> : null}
      {data.map((o) => (
        <Card key={o.id}>
          <CardContent className="grid gap-2 pt-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{o.number}</span>
              <Badge variant={STATUS_BADGE[o.status]}>{PREORDER_STATUS_LABELS[o.status]}</Badge>
              <span className="text-muted-foreground">retrait le {formatDate(o.pickupDate)}</span>
              <span className="ml-auto tabular-nums">{euro(o.totalCents / 100)}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  o.lines.forEach((l) =>
                    cart.add(
                      {
                        productId: l.productId,
                        name: l.label,
                        unitPriceCents: decimalToCents(l.unitPrice),
                        unit: null,
                      },
                      l.qty,
                    ),
                  )
                }
              >
                Commander à nouveau
              </Button>
              {memberCanCancel(o.status) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (
                      await confirmNow({
                        title: `Annuler la commande ${o.number} ?`,
                        message: 'Les produits ne seront pas préparés.',
                        confirmLabel: 'Annuler la commande',
                        cancelLabel: 'Garder la commande',
                        destructive: true,
                      })
                    )
                      cancel.mutate(o.id);
                  }}
                >
                  Annuler
                </Button>
              ) : null}
            </div>
            <p className="text-muted-foreground">
              {o.lines
                .map((l) => `${formatQty(parseQtyToMilli(l.qty) ?? 0)} × ${l.label}`)
                .join(' · ')}
            </p>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
