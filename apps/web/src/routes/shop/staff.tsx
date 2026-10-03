import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PREORDER_STATUSES,
  PREORDER_STATUS_LABELS,
  canTransition,
  formatQty,
  hasAnyRole,
  parseQtyToMilli,
  type PreorderStatus,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { euro, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { SortTh, useSort } from '@/components/ui/sortable';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';
import type { MyOrder } from './shop';

interface OrderRow {
  id: string;
  number: string;
  status: PreorderStatus;
  pickupDate: string;
  memberNumber: number;
  memberName: string;
  lineCount: number;
  total: string;
}

interface OrderDetail extends MyOrder {
  memberName: string;
  memberId: string;
}

const SORT = {
  number: (o: OrderRow) => o.number,
  pickup: (o: OrderRow) => o.pickupDate,
  member: (o: OrderRow) => o.memberName,
  status: (o: OrderRow) => o.status,
  total: (o: OrderRow) => Number(o.total),
};

const BADGE: Record<PreorderStatus, 'default' | 'success' | 'muted' | 'destructive'> = {
  SUBMITTED: 'default',
  READY: 'success',
  PICKED_UP: 'muted',
  CANCELLED: 'destructive',
};

/** Customer pre-orders, for the volunteers who prepare them (§4.14). */
export function PreordersPage() {
  const [status, setStatus] = useState<PreorderStatus | 'open'>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, error } = useQuery({
    queryKey: ['preorders', status],
    queryFn: () =>
      api.get<OrderRow[]>(`/preorders?${status === 'open' ? 'open=true' : `status=${status}`}`),
  });
  const sort = useSort(data, SORT);
  return (
    <>
      <PageHeader
        title="Précommandes"
        description="Commandes passées par les adhérents depuis la boutique. Elles sont retirées et réglées en caisse."
      />
      <div className="mb-4">
        <Select
          aria-label="État"
          className="w-56"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="open">À préparer ou prêtes</option>
          {PREORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PREORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="pickup">
                Retrait
              </SortTh>
              <SortTh state={sort} sortKey="number">
                N°
              </SortTh>
              <SortTh state={sort} sortKey="member">
                Adhérent
              </SortTh>
              <SortTh state={sort} sortKey="status">
                État
              </SortTh>
              <SortTh state={sort} sortKey="total" className="text-right">
                Total
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {(sort.rows ?? []).map((o) => (
              <tr key={o.id}>
                <td>{formatDate(o.pickupDate)}</td>
                <td>
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => setOpenId(o.id)}
                  >
                    {o.number}
                  </button>
                </td>
                <td>{o.memberName}</td>
                <td>
                  <Badge variant={BADGE[o.status]}>{PREORDER_STATUS_LABELS[o.status]}</Badge>
                </td>
                <td className="text-right tabular-nums">{euro(o.total)}</td>
              </tr>
            ))}
            {data?.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucune précommande.
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>
      <OrderDialog id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function OrderDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['preorder', id],
    queryFn: () => api.get<OrderDetail>(`/preorders/${id}`),
    enabled: !!id,
  });
  const change = useMutation({
    mutationFn: (status: PreorderStatus) => api.post(`/preorders/${id}/status`, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['preorders'] });
      await queryClient.invalidateQueries({ queryKey: ['preorder', id] });
    },
  });
  const manager = hasAnyRole(me.roles, ['COMMANDES_GESTION']);
  return (
    <Dialog
      open={!!id}
      onClose={onClose}
      title={data ? `Commande ${data.number}` : 'Commande'}
      description={
        data ? `${data.memberName} · retrait le ${formatDate(data.pickupDate)}` : undefined
      }
    >
      {data ? (
        <div className="grid gap-3 text-sm">
          <Table>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td className="text-right tabular-nums">
                    {formatQty(parseQtyToMilli(l.qty) ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="flex justify-between font-medium">
            <span>Total estimé</span>
            <span className="tabular-nums">{euro(data.totalCents / 100)}</span>
          </p>
          {data.comment ? <p className="text-muted-foreground">« {data.comment} »</p> : null}
          {change.error ? <Alert>{change.error.message}</Alert> : null}
          {manager ? (
            <div className="flex flex-wrap gap-2">
              {canTransition(data.status, 'READY') ? (
                <Button onClick={() => change.mutate('READY')}>Marquer prête</Button>
              ) : null}
              {data.status === 'READY' ? (
                <Button variant="outline" onClick={() => change.mutate('SUBMITTED')}>
                  Remettre à préparer
                </Button>
              ) : null}
              {canTransition(data.status, 'CANCELLED') ? (
                <Button
                  variant="destructive"
                  onClick={() =>
                    window.confirm('Annuler cette commande ?') && change.mutate('CANCELLED')
                  }
                >
                  Annuler la commande
                </Button>
              ) : null}
            </div>
          ) : null}
          {data.status === 'READY' || data.status === 'SUBMITTED' ? (
            <p className="text-xs text-muted-foreground">
              Au retrait, ouvrez la caisse et choisissez « Précommandes » : le ticket se remplit
              seul.
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
