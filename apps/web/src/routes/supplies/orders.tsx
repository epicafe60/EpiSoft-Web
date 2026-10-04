import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, FileSpreadsheet, PackageCheck, Plus, Send, Trash2 } from 'lucide-react';
import {
  centsToDecimal,
  formatEuro,
  formatQty,
  inclFromExcl4,
  margin,
  orderTotals,
  parsePrice4,
  parseQtyToMilli,
  salePriceForMarkup,
  type PriceRounding,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate, todayIso } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import { ProductPicker } from '@/components/product-picker';
import {
  ORDER_STATUS_LABELS,
  type OrderDetail,
  type OrderRow,
  type OrderStatus,
  type SupplierRow,
} from '@/lib/types-supplies';
import { SortTh, useSort, NoMatchRow } from '@/components/ui/sortable';
import { QueryError } from '../errors';

const statusVariant = (s: OrderStatus) =>
  s === 'RECEIVED' || s === 'CLOSED' ? 'success' : s === 'CANCELLED' ? 'muted' : 'default';

/** R-CMD-08: list with supplier, status and period filters, totals and Excel export. */
const ORDER_SORT = {
  number: (o: OrderRow) => o.number,
  date: (o: OrderRow) => o.date,
  supplier: (o: OrderRow) => o.supplierName,
  status: (o: OrderRow) => ORDER_STATUS_LABELS[o.status],
  total: (o: OrderRow) => Number(o.totalIncl),
};

export function OrdersPage() {
  const navigate = useNavigate();
  const [supplierId, setSupplierId] = useState('');
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [newFor, setNewFor] = useState('');
  const suppliers = useQuery({
    queryKey: ['suppliers', 'active'],
    queryFn: () => api.get<SupplierRow[]>('/suppliers?active=true'),
  });
  const params = new URLSearchParams();
  if (supplierId) params.set('supplierId', supplierId);
  if (status) params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data, error } = useQuery({
    queryKey: ['orders', params.toString()],
    queryFn: () => api.get<OrderRow[]>(`/purchase-orders?${params}`),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/purchase-orders', { supplierId: newFor }),
    onSuccess: (o) => navigate({ to: '/appros/commandes/$id', params: { id: o.id } }),
  });
  const totals = (data ?? [])
    .filter((o) => o.status !== 'CANCELLED')
    .reduce((s, o) => s + Math.round(Number(o.totalIncl) * 100), 0);

  const sort = useSort(data, ORDER_SORT);
  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <Field label="Nouvelle commande pour">
            {(p) => (
              <Select
                {...p}
                className="w-64"
                value={newFor}
                onChange={(e) => setNewFor(e.target.value)}
              >
                <option value="">Choisir un fournisseur…</option>
                {(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button onClick={() => create.mutate()} disabled={!newFor || create.isPending}>
            <Plus /> Préparer la commande
          </Button>
          <p className="text-xs text-muted-foreground">
            Préremplie avec les produits actifs sous leur stock minimum (R-CMD-01).
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end gap-3">
        <Select
          aria-label="Fournisseur"
          className="w-56"
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
        >
          <option value="">Tous les fournisseurs</option>
          {(suppliers.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="État"
          className="w-48"
          value={status}
          onChange={(e) => setStatus(e.target.value as OrderStatus | '')}
        >
          <option value="">Tous les états</option>
          {Object.entries(ORDER_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          aria-label="Du"
          className="w-40"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          type="date"
          aria-label="Au"
          className="w-40"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <a
          className={buttonVariants({ variant: 'outline' })}
          href={`/api/v1/purchase-orders.xlsx?${params}`}
        >
          <FileSpreadsheet /> Excel
        </a>
      </div>
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="number">
                N°
              </SortTh>
              <SortTh state={sort} sortKey="date">
                Date
              </SortTh>
              <SortTh state={sort} sortKey="supplier">
                Fournisseur
              </SortTh>
              <SortTh state={sort} sortKey="status">
                État
              </SortTh>
              <SortTh state={sort} sortKey="total" className="text-right">
                Total TTC
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {(sort.rows ?? []).map((o) => (
              <tr key={o.id}>
                <td>
                  <Link
                    to="/appros/commandes/$id"
                    params={{ id: o.id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {o.number}
                  </Link>
                </td>
                <td className="tabular-nums">{formatDate(o.date)}</td>
                <td>{o.supplierName}</td>
                <td>
                  <Badge variant={statusVariant(o.status)}>{ORDER_STATUS_LABELS[o.status]}</Badge>
                </td>
                <td className="text-right tabular-nums">{euro(o.totalIncl)}</td>
              </tr>
            ))}
            {data?.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucune commande.
                </td>
              </tr>
            ) : null}
          </tbody>
          <NoMatchRow state={sort} total={data?.length} />
          {data?.length ? (
            <tfoot>
              <tr className="border-t font-medium">
                <td colSpan={4}>Total (hors annulées)</td>
                <td className="text-right tabular-nums">{formatEuro(centsToDecimal(totals))}</td>
              </tr>
            </tfoot>
          ) : null}
        </Table>
      </Card>
    </div>
  );
}

interface EditLine {
  productId: string;
  code: string;
  name: string;
  qty: string;
  unitPriceExcl: string;
  vatRate: string;
}

export function OrderPage() {
  const { id } = useParams({ from: '/app/appros/commandes/$id' });
  const queryClient = useQueryClient();
  const { data: o, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderDetail>(`/purchase-orders/${id}`),
  });
  const [dialog, setDialog] = useState<'send' | 'receive' | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['order', id] }),
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
    ]);
  const action = useMutation({
    mutationFn: (path: string) => api.post(`/purchase-orders/${id}/${path}`),
    onSuccess: refresh,
  });
  if (error) return <QueryError error={error} />;
  if (!o) return <p className="text-muted-foreground">Chargement…</p>;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            Commande {o.number}{' '}
            <Badge variant={statusVariant(o.status)}>{ORDER_STATUS_LABELS[o.status]}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">
            {o.supplier?.name} · {formatDate(o.date)}
            {o.sentAt ? ` · envoyée à ${o.sentTo} le ${formatDate(o.sentAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={`/api/v1/purchase-orders/${id}/pdf`}
            target="_blank"
            rel="noreferrer"
          >
            <FileDown /> Bon de commande
          </a>
          {o.status === 'DRAFT' || o.status === 'SENT' ? (
            <Button variant="outline" onClick={() => setDialog('send')} disabled={!o.lines.length}>
              <Send /> Envoyer
            </Button>
          ) : null}
          {['DRAFT', 'SENT', 'PARTIAL'].includes(o.status) ? (
            <Button onClick={() => setDialog('receive')} disabled={!o.lines.length}>
              <PackageCheck /> Réceptionner
            </Button>
          ) : null}
          {o.status === 'PARTIAL' || o.status === 'SENT' ? (
            <Button
              variant="outline"
              onClick={() =>
                window.confirm('Solder la commande sans attendre le reliquat (R-CMD-06) ?') &&
                action.mutate('close')
              }
            >
              Solder
            </Button>
          ) : null}
          {o.status === 'DRAFT' || o.status === 'SENT' ? (
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() => window.confirm('Annuler cette commande ?') && action.mutate('cancel')}
            >
              Annuler
            </Button>
          ) : null}
        </div>
      </div>
      {action.error ? <Alert>{action.error.message}</Alert> : null}
      {o.status === 'DRAFT' ? (
        <DraftEditor order={o} onSaved={refresh} />
      ) : (
        <OrderLines order={o} />
      )}
      {o.receipts.length ? (
        <p className="text-sm text-muted-foreground">
          Réceptions : {o.receipts.map((r) => `${r.number} du ${formatDate(r.date)}`).join(', ')}
        </p>
      ) : null}
      <SendDialog
        order={o}
        open={dialog === 'send'}
        onClose={() => setDialog(null)}
        onDone={refresh}
      />
      <ReceiveDialog
        order={o}
        open={dialog === 'receive'}
        onClose={() => setDialog(null)}
        onDone={refresh}
      />
    </div>
  );
}

function OrderLines({ order }: { order: OrderDetail }) {
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <th>Produit</th>
            <th className="text-right">Commandé</th>
            <th className="text-right">Reçu</th>
            <th className="text-right">PA HT</th>
            <th className="text-right">Total HT</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.id}>
              <td>
                <span className="text-muted-foreground">{l.code}</span> {l.name}
              </td>
              <td className="text-right tabular-nums">
                {formatQty(parseQtyToMilli(l.qtyOrdered)!)}
              </td>
              <td className="text-right tabular-nums">
                {formatQty(parseQtyToMilli(l.qtyReceived)!)}
              </td>
              <td className="text-right tabular-nums">{euro(l.unitPriceExcl)}</td>
              <td className="text-right tabular-nums">{euro(l.totalExcl)}</td>
            </tr>
          ))}
        </tbody>
        <Totals ht={order.totalExcl} vat={order.totalVat} ttc={order.totalIncl} span={4} />
      </Table>
    </Card>
  );
}

function Totals({ ht, vat, ttc, span }: { ht: string; vat: string; ttc: string; span: number }) {
  return (
    <tfoot className="text-sm">
      <tr className="border-t">
        <td colSpan={span} className="text-right text-muted-foreground">
          Total HT
        </td>
        <td className="text-right tabular-nums">{euro(ht)}</td>
      </tr>
      <tr>
        <td colSpan={span} className="text-right text-muted-foreground">
          TVA
        </td>
        <td className="text-right tabular-nums">{euro(vat)}</td>
      </tr>
      <tr className="font-semibold">
        <td colSpan={span} className="text-right">
          Total TTC
        </td>
        <td className="text-right tabular-nums">{euro(ttc)}</td>
      </tr>
    </tfoot>
  );
}

/** R-CMD-01/02: editable quantities and purchase prices, totals per line then cumulated. */
function DraftEditor({ order, onSaved }: { order: OrderDetail; onSaved: () => Promise<unknown> }) {
  const [lines, setLines] = useState<EditLine[]>([]);
  const [comment, setComment] = useState(order.comment ?? '');
  useEffect(() => {
    setLines(
      order.lines.map((l) => ({
        productId: l.productId,
        code: l.code,
        name: l.name,
        qty: formatQty(parseQtyToMilli(l.qtyOrdered)!),
        unitPriceExcl: l.unitPriceExcl.replace(/0+$/, '').replace(/\.$/, ''),
        vatRate: l.vatRate,
      })),
    );
    setComment(order.comment ?? '');
  }, [order]);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/purchase-orders/${order.id}`, {
        comment,
        lines: lines.map((l) => ({
          productId: l.productId,
          qty: l.qty || '0',
          unitPriceExcl: l.unitPriceExcl || '0',
        })),
      }),
    onSuccess: onSaved,
  });
  const totals = useMemo(
    () =>
      orderTotals(
        lines.map((l) => ({
          qtyMilli: parseQtyToMilli(l.qty || '0') ?? 0,
          unitPriceExcl4: parsePrice4(l.unitPriceExcl || '0') ?? 0,
          vatRate: l.vatRate,
        })),
      ),
    [lines],
  );
  const set = (i: number, patch: Partial<EditLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const min = order.supplier?.minOrderAmount;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lignes de la commande</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ProductPicker
          onPick={(p) => {
            if (lines.some((l) => l.productId === p.id)) return;
            setLines([
              ...lines,
              {
                productId: p.id,
                code: p.code,
                name: p.name,
                qty: '1',
                unitPriceExcl: '0',
                vatRate: '5.50',
              },
            ]);
          }}
        />
        <Table className="stack-rows">
          <thead>
            <tr>
              <th>Produit</th>
              <th className="w-28 text-right">Quantité</th>
              <th className="w-32 text-right">PA HT</th>
              <th className="text-right">Total HT</th>
              <th className="w-0" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.productId}>
                <td data-wide>
                  <span className="text-muted-foreground">{l.code}</span> {l.name}
                </td>
                <td data-label="Quantité">
                  <Input
                    aria-label={`Quantité ${l.name}`}
                    inputMode="decimal"
                    className="text-right"
                    value={l.qty}
                    onChange={(e) => set(i, { qty: e.target.value })}
                  />
                </td>
                <td data-label="PA HT">
                  <Input
                    aria-label={`PA HT ${l.name}`}
                    inputMode="decimal"
                    className="text-right"
                    value={l.unitPriceExcl}
                    onChange={(e) => set(i, { unitPriceExcl: e.target.value })}
                  />
                </td>
                <td className="text-right tabular-nums" data-label="Total HT">
                  {euro(
                    centsToDecimal(
                      orderTotals([
                        {
                          qtyMilli: parseQtyToMilli(l.qty || '0') ?? 0,
                          unitPriceExcl4: parsePrice4(l.unitPriceExcl || '0') ?? 0,
                          vatRate: l.vatRate,
                        },
                      ]).exclCents,
                    ),
                  )}
                </td>
                <td data-actions>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Retirer ${l.name}`}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <Totals
            ht={centsToDecimal(totals.exclCents)}
            vat={centsToDecimal(totals.vatCents)}
            ttc={centsToDecimal(totals.inclCents)}
            span={3}
          />
        </Table>
        {min && totals.exclCents < Math.round(Number(min) * 100) ? (
          <Alert variant="info">Minimum de commande du fournisseur : {euro(min)} HT.</Alert>
        ) : null}
        <Field label="Commentaire">
          {(p) => <Textarea {...p} value={comment} onChange={(e) => setComment(e.target.value)} />}
        </Field>
        {save.error ? <Alert>{save.error.message}</Alert> : null}
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Enregistrer
          </Button>
          {save.isSuccess ? <span className="text-sm text-success">Enregistré.</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** R-CMD-04: e-mail with an editable text; the PDF is attached by the server. */
function SendDialog({
  order,
  open,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (open) {
      setTo(order.supplier?.email ?? '');
      setSubject(`Commande ${order.number} — Épicafé de Montjavoult`);
      setMessage(
        `Bonjour,\n\nVeuillez trouver ci-joint notre bon de commande ${order.number}.\n\nMerci de nous confirmer la date de livraison.\n\nCordialement,\nL’Épicafé de Montjavoult`,
      );
    }
  }, [open, order]);
  const send = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${order.id}/send`, { to, subject, message }),
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Envoyer le bon de commande" className="max-w-xl">
      <div className="grid gap-3">
        <Field
          label="Destinataire"
          hint={
            order.supplier?.email
              ? undefined
              : 'Le fournisseur n’a pas de courriel : saisissez une adresse.'
          }
        >
          {(p) => <Input {...p} type="email" value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
        <Field label="Objet">
          {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}
        </Field>
        <Field label="Message">
          {(p) => (
            <Textarea
              {...p}
              className="min-h-40"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          )}
        </Field>
        {send.error ? <Alert>{send.error.message}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={() => send.mutate()} disabled={!to || send.isPending}>
            <Send /> Envoyer avec le PDF
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

interface ReceiveLine {
  orderLineId: string | null;
  productId: string;
  name: string;
  remaining: string;
  qty: string;
  unitPriceExcl: string;
  vatRate: string;
  salePrice: string;
  newSalePrice: string;
  bestBefore: string;
}

/**
 * R-CMD-05/06: quantity received prefilled with what is still expected, actual purchase
 * price, unordered products can be added; a new selling price is suggested from the target
 * margin when the purchase price changes.
 */
function ReceiveDialog({
  order,
  open,
  onClose,
  onDone,
}: {
  order: OrderDetail;
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const pricing = useQuery({
    queryKey: ['pricing'],
    queryFn: () =>
      api.get<{ targetMarkupPct: number; rounding: PriceRounding }>('/catalog/pricing'),
    enabled: open,
  });
  const [lines, setLines] = useState<ReceiveLine[]>([]);
  const [closeOrder, setCloseOrder] = useState(false);
  const [date, setDate] = useState(todayIso());
  useEffect(() => {
    if (!open) return;
    setDate(todayIso());
    setCloseOrder(false);
    setLines(
      order.lines.map((l) => {
        const remaining = Math.max(
          0,
          parseQtyToMilli(l.qtyOrdered)! - parseQtyToMilli(l.qtyReceived)!,
        );
        return {
          orderLineId: l.id,
          productId: l.productId,
          name: l.name,
          remaining: formatQty(remaining),
          qty: remaining ? formatQty(remaining) : '',
          unitPriceExcl: Number(l.unitPriceExcl).toString(),
          vatRate: l.vatRate,
          salePrice: l.salePrice,
          newSalePrice: '',
          bestBefore: '',
        };
      }),
    );
  }, [open, order]);
  const set = (i: number, patch: Partial<ReceiveLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const receive = useMutation({
    mutationFn: () => {
      const received = lines.filter((l) => (parseQtyToMilli(l.qty || '0') ?? 0) > 0);
      return api.post(`/purchase-orders/${order.id}/receipts`, {
        date,
        closeOrder,
        lines: received.map((l) => ({
          orderLineId: l.orderLineId,
          productId: l.productId,
          qty: l.qty,
          unitPriceExcl: l.unitPriceExcl,
          bestBefore: l.bestBefore || null,
        })),
        newSalePrices: Object.fromEntries(
          received.filter((l) => l.newSalePrice).map((l) => [l.productId, l.newSalePrice]),
        ),
      });
    },
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Réception — ${order.number}`}
      className="max-w-4xl"
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Date de réception">
            {(p) => (
              <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <ProductPicker
            placeholder="Ajouter un produit reçu non commandé…"
            onPick={(p) =>
              setLines([
                ...lines,
                {
                  orderLineId: null,
                  productId: p.id,
                  name: p.name,
                  remaining: '—',
                  qty: '1',
                  unitPriceExcl: '0',
                  vatRate: '5.50',
                  salePrice: p.salePrice,
                  newSalePrice: '',
                  bestBefore: '',
                },
              ])
            }
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          <Table className="stack-rows">
            <thead>
              <tr>
                <th>Produit</th>
                <th className="text-right">Attendu</th>
                <th className="w-24 text-right">Reçu</th>
                <th className="w-28 text-right">PA HT réel</th>
                <th className="w-36">DLC (option)</th>
                <th className="w-44">Nouveau PV</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const excl4 = parsePrice4(l.unitPriceExcl || '0') ?? 0;
                const incl4 = inclFromExcl4(excl4, l.vatRate);
                const current = margin(Math.round(Number(l.salePrice) * 100), incl4);
                const suggested = pricing.data
                  ? salePriceForMarkup(incl4, pricing.data.targetMarkupPct, pricing.data.rounding)
                  : null;
                return (
                  <tr key={`${l.productId}-${i}`}>
                    <td data-wide>
                      {l.name}
                      <span className="block text-xs text-muted-foreground">
                        PV {euro(l.salePrice)}
                        {current ? ` · marque ${current.ratePct.toLocaleString('fr-FR')} %` : ''}
                      </span>
                    </td>
                    <td className="text-right tabular-nums" data-label="Attendu">
                      {l.remaining}
                    </td>
                    <td data-label="Reçu">
                      <Input
                        aria-label={`Quantité reçue ${l.name}`}
                        inputMode="decimal"
                        className="text-right"
                        value={l.qty}
                        onChange={(e) => set(i, { qty: e.target.value })}
                      />
                    </td>
                    <td data-label="PA HT réel">
                      <Input
                        aria-label={`PA HT ${l.name}`}
                        inputMode="decimal"
                        className="text-right"
                        value={l.unitPriceExcl}
                        onChange={(e) => set(i, { unitPriceExcl: e.target.value })}
                      />
                    </td>
                    <td data-label="DLC (option)">
                      <Input
                        aria-label={`DLC ${l.name}`}
                        type="date"
                        value={l.bestBefore}
                        onChange={(e) => set(i, { bestBefore: e.target.value })}
                      />
                    </td>
                    <td data-label="Nouveau PV" data-wide>
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`Nouveau PV ${l.name}`}
                          inputMode="decimal"
                          className="text-right"
                          placeholder="inchangé"
                          value={l.newSalePrice}
                          onChange={(e) => set(i, { newSalePrice: e.target.value })}
                        />
                        {suggested && suggested !== Math.round(Number(l.salePrice) * 100) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Prix suggéré selon la marge cible"
                            onClick={() => set(i, { newSalePrice: centsToDecimal(suggested) })}
                          >
                            {euro(centsToDecimal(suggested))}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="close-order"
            checked={closeOrder}
            onChange={(e) => setCloseOrder(e.target.checked)}
          />
          <Label htmlFor="close-order" className="font-normal">
            Solder la commande : ne pas attendre le reliquat (R-CMD-06)
          </Label>
        </div>
        {receive.error ? <Alert>{receive.error.message}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={() => receive.mutate()} disabled={receive.isPending}>
            <PackageCheck /> Valider la réception
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
