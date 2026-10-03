import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { formatQty, parseQtyToMilli, PAYMENT_METHOD_LABELS } from '@episoft/shared';
import { api } from '@/lib/api';
import { euro } from '@/lib/format';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/form';
import type { SaleDetail } from '@/lib/types';

/** Ticket detail with resend by e-mail (R-VTE-16). */
export function SaleDialog({ saleId, onClose }: { saleId: string | null; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['sale', saleId],
    queryFn: () => api.get<SaleDetail>(`/pos/sales/${saleId}`),
    enabled: !!saleId,
  });
  const resend = useMutation({ mutationFn: () => api.post(`/pos/sales/${saleId}/email`) });
  return (
    <Dialog
      open={!!saleId}
      onClose={onClose}
      title={data ? `Ticket ${data.number}` : 'Ticket'}
      className="max-w-2xl"
    >
      {data ? (
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            {formatDateTime(data.soldAt)} · caissier : {data.cashierName ?? '—'} · adhérent :{' '}
            {data.memberName ?? 'sans adhérent'}
            {data.provisionalNumber ? ` · n° provisoire ${data.provisionalNumber}` : ''}
          </p>
          {data.status === 'CANCELLED' ? (
            <Alert>
              Ce ticket a été annulé
              {data.cancelledBy ? ` par le ticket ${data.cancelledBy.number}` : ''}.
            </Alert>
          ) : null}
          {data.warnings?.length ? (
            <Alert variant="info">
              {data.warnings.map((w) => (
                <span key={w.code} className="block">
                  {w.message}
                </span>
              ))}
            </Alert>
          ) : null}
          <Table>
            <thead>
              <tr>
                <th>Article</th>
                <th className="text-right">Qté</th>
                <th className="text-right">P.U.</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.label}
                    {l.catalogPrice && Number(l.catalogPrice) !== Number(l.unitPrice) ? (
                      <span className="block text-xs text-muted-foreground">
                        prix catalogue {euro(l.catalogPrice)}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatQty(parseQtyToMilli(l.qty) ?? 0)}
                  </td>
                  <td className="text-right tabular-nums">{euro(l.unitPrice)}</td>
                  <td className="text-right tabular-nums">{euro(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {data.payments.map((p) => (
                <Badge key={p.id}>
                  {PAYMENT_METHOD_LABELS[p.method]} {euro(p.amount)}
                </Badge>
              ))}
            </div>
            <p className="text-base font-semibold">Total {euro(data.total)}</p>
          </div>
          <div className="flex items-center justify-end gap-3">
            {resend.isSuccess ? <span className="text-success">Courriel envoyé.</span> : null}
            {resend.error ? <span className="text-destructive">{resend.error.message}</span> : null}
            <Button
              variant="outline"
              onClick={() => resend.mutate()}
              disabled={resend.isPending || !data.memberId}
            >
              <Mail /> Renvoyer par courriel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground">Chargement…</p>
      )}
    </Dialog>
  );
}
