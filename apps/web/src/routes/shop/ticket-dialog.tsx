import { useQuery } from '@tanstack/react-query';
import {
  formatQty,
  PAYMENT_METHOD_LABELS,
  parseQtyToMilli,
  type PaymentMethod,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { euro, formatDate } from '@/lib/format';
import { Dialog } from '@/components/ui/dialog';
import { Table } from '@/components/ui/card';
import { QueryError } from '../errors';

interface Ticket {
  number: string;
  soldAt: string;
  total: string;
  status: 'COMPLETED' | 'CANCELLED';
  lines: { label: string; qty: string; unitPrice: string; discount: string; lineTotal: string }[];
  payments: { method: PaymentMethod; amount: string }[];
}

/** Read-only view of one of the household's own tickets. */
export function TicketDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, error } = useQuery({
    queryKey: ['my-ticket', id],
    queryFn: () => api.get<Ticket>(`/me/tickets/${id}`),
    enabled: !!id,
  });
  return (
    <Dialog
      open={!!id}
      onClose={onClose}
      title={data ? `Ticket ${data.number}` : 'Ticket'}
      description={data ? formatDate(data.soldAt) : undefined}
    >
      {error ? <QueryError error={error} /> : null}
      {data ? (
        <div className="grid gap-3" data-testid="ticket-detail">
          {data.status === 'CANCELLED' ? (
            <p className="text-sm font-medium text-destructive">Ticket annulé</p>
          ) : null}
          <Table>
            <thead>
              <tr>
                <th>Article</th>
                <th className="text-right">Qté</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    {l.label}
                    <span className="block text-xs text-muted-foreground">
                      {euro(l.unitPrice)} l’unité
                      {Number(l.discount) !== 0 ? ` · remise ${euro(l.discount)}` : ''}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">
                    {formatQty(parseQtyToMilli(l.qty) ?? 0)}
                  </td>
                  <td className="text-right tabular-nums">{euro(l.lineTotal)}</td>
                </tr>
              ))}
              {data.lines.length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-muted-foreground">
                    Détail des articles indisponible.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </Table>
          <p className="flex justify-between border-t pt-2 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{euro(data.total)}</span>
          </p>
          <ul className="text-sm text-muted-foreground">
            {data.payments.map((p, i) => (
              <li key={i} className="flex justify-between">
                <span>{PAYMENT_METHOD_LABELS[p.method]}</span>
                <span className="tabular-nums">{euro(p.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  );
}
