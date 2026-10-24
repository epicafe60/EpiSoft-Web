import { useState } from 'react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { confirmNow } from '@/components/confirm';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, FileSpreadsheet, PackageCheck, Plus, Send, Trash2 } from 'lucide-react';
import { centsToDecimal, formatEuro, formatQty, parseQtyToMilli } from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardContent, Table } from '@/components/ui/card';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import {
  ORDER_STATUS_LABELS,
  type OrderDetail,
  type OrderRow,
  type OrderStatus,
  type SupplierRow,
} from '@/lib/types-supplies';
import { SortTh, useSort, NoMatchRow } from '@/components/ui/sortable';
import { QueryError } from '../errors';
import {
  Totals,
  DraftEditor,
  SendDialog,
  ReceiveDialog,
  CorrectReceiptDialog,
} from './order-panels';

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
            Préremplie avec les produits actifs sous leur stock minimum.
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

export function OrderPage() {
  const { id } = useParams({ from: '/app/appros/commandes/$id' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: o, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderDetail>(`/purchase-orders/${id}`),
  });
  const [dialog, setDialog] = useState<'send' | 'receive' | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['order', id] }),
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
    ]);
  const action = useMutation({
    mutationFn: (path: string) => api.post(`/purchase-orders/${id}/${path}`),
    onSuccess: refresh,
  });
  // R-EVO-12: a cancelled (or draft) order can be deleted.
  const remove = useMutation({
    mutationFn: () => api.delete(`/purchase-orders/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await navigate({ to: '/appros/commandes' });
    },
  });
  if (error) return <QueryError error={error} />;
  if (!o) return <p className="text-muted-foreground">Chargement…</p>;

  return (
    <div className="grid gap-4">
      <Breadcrumbs
        items={[
          { label: 'Approvisionnements', to: '/appros' },
          { label: 'Commandes', to: '/appros/commandes' },
          { label: `Commande ${o.number}` },
        ]}
      />
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
          {/* R-EVO-14: opens the mail client; the PDF is downloaded above, to be attached. */}
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={`mailto:${o.supplier?.email ?? ''}?${new URLSearchParams({
              subject: `Commande ${o.number} — Épicafé de Montjavoult`,
              body: `Bonjour,

Veuillez trouver ci-joint notre bon de commande ${o.number}.

Merci de nous confirmer la date de livraison.

Cordialement,
L’Épicafé de Montjavoult`,
            })
              .toString()
              .replace(/\+/g, '%20')}`}
          >
            <Send /> Ouvrir dans ma messagerie
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
              onClick={async () => {
                if (
                  await confirmNow({
                    title: 'Solder la commande ?',
                    message:
                      'La commande sera terminée sans attendre ce qui n’est pas encore livré.',
                    confirmLabel: 'Solder',
                  })
                )
                  action.mutate('close');
              }}
            >
              Solder
            </Button>
          ) : null}
          {o.status === 'DRAFT' || o.status === 'SENT' ? (
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={async () => {
                if (
                  await confirmNow({
                    title: 'Annuler cette commande ?',
                    message: 'Elle ne sera plus attendue du fournisseur.',
                    confirmLabel: 'Annuler la commande',
                    cancelLabel: 'Garder la commande',
                    destructive: true,
                  })
                )
                  action.mutate('cancel');
              }}
            >
              Annuler
            </Button>
          ) : null}
          {o.status === 'DRAFT' || o.status === 'CANCELLED' ? (
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={remove.isPending}
              onClick={async () => {
                if (
                  await confirmNow({
                    title: `Supprimer la commande ${o.number} ?`,
                    message: 'La commande disparaît définitivement de la liste.',
                    confirmLabel: 'Supprimer',
                    destructive: true,
                  })
                )
                  remove.mutate();
              }}
            >
              <Trash2 /> Supprimer
            </Button>
          ) : null}
        </div>
      </div>
      {action.error ? <Alert>{action.error.message}</Alert> : null}
      {remove.error ? <Alert>{remove.error.message}</Alert> : null}
      {o.status === 'DRAFT' ? (
        <DraftEditor order={o} onSaved={refresh} />
      ) : (
        <OrderLines order={o} />
      )}
      {o.receipts.length ? (
        <ul className="grid gap-1 text-sm text-muted-foreground" aria-label="Réceptions">
          {o.receipts.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span>
                Réception {r.number} du {formatDate(r.date)}
                {r.receivedByName ? ` (saisie par ${r.receivedByName})` : ''}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setCorrecting(r.id)}>
                Corriger
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <CorrectReceiptDialog id={correcting} onClose={() => setCorrecting(null)} onDone={refresh} />
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
