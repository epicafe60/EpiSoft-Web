import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Ban, CheckCircle2, Clock, XCircle } from 'lucide-react';
import {
  formatEuro,
  formatQty,
  parseQtyToMilli,
  PAYMENT_METHOD_LABELS,
  provisionalNumber,
  type SyncOp,
} from '@episoft/shared';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input } from '@/components/ui/form';
import { tillDb, type OutboxEntry } from './db';
import { useTill } from './context';
import { enqueue } from './sync';

type SaleEntry = OutboxEntry & { op: Extract<SyncOp, { kind: 'SALE' }> };

function Status({ e }: { e: OutboxEntry }) {
  if (e.status === 'PENDING')
    return (
      <Badge variant="muted">
        <Clock className="mr-1 size-3" />
        En attente
      </Badge>
    );
  if (e.status === 'REJECTED')
    return (
      <Badge variant="destructive">
        <XCircle className="mr-1 size-3" />
        Refusé
      </Badge>
    );
  return (
    <Badge variant="success">
      <CheckCircle2 className="mr-1 size-3" />
      {e.result?.number ?? 'Envoyé'}
    </Badge>
  );
}

/** The tickets of the current session, from this device's outbox: works offline. */
export function TicketsPage() {
  const { meta, cashierId, engine } = useTill();
  const entries = useLiveQuery(() => tillDb.outbox.orderBy('seq').reverse().toArray(), []);
  const members = useLiveQuery(() => tillDb.members.toArray(), []);
  const [selected, setSelected] = useState<SaleEntry | null>(null);
  const [reason, setReason] = useState('');

  if (!entries || !members) return <p className="p-6 text-muted-foreground">Chargement…</p>;
  const sessionId = meta.session?.id;
  const sales = entries.filter(
    (e): e is SaleEntry => e.op.kind === 'SALE' && e.op.payload.sessionId === sessionId,
  );
  const cancelled = new Set(
    entries.flatMap((e) =>
      e.op.kind === 'SALE_CANCEL' && e.status !== 'REJECTED' ? [e.op.payload.saleId] : [],
    ),
  );
  const others = entries.filter((e) => e.op.kind !== 'SALE' && e.status === 'REJECTED');
  const nameOf = (id: string | null) => {
    const m = members.find((x) => x.id === id);
    return m ? `${m.firstName} ${m.lastName}` : 'Sans adhérent';
  };

  const cancel = async (s: SaleEntry) => {
    await enqueue((deviceSeq) => ({
      kind: 'SALE_CANCEL',
      id: crypto.randomUUID(),
      deviceSeq,
      payload: {
        cancelSaleId: crypto.randomUUID(),
        saleId: s.id,
        sessionId: sessionId!,
        cashierId,
        at: new Date().toISOString(),
        provisionalNumber: provisionalNumber(meta.device!.name, deviceSeq),
        reason: reason.trim() || undefined,
      },
    }));
    engine.kick();
    setSelected(null);
    setReason('');
  };

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4 p-4">
      <h1 className="text-xl font-semibold">Tickets de la session</h1>
      {others.length ? (
        <Alert>
          {others.map((o) => (
            <span key={o.id} className="block">
              Opération refusée ({o.kind}) : {o.lastError}
            </span>
          ))}
        </Alert>
      ) : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <th>Heure</th>
              <th>N° provisoire</th>
              <th>Adhérent</th>
              <th>État</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {sales.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucun ticket dans cette session.
                </td>
              </tr>
            ) : (
              sales.map((s) => (
                <tr
                  key={s.id}
                  className={cancelled.has(s.id) ? 'text-muted-foreground line-through' : ''}
                >
                  <td className="tabular-nums">{formatDateTime(s.op.payload.soldAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setSelected(s)}
                    >
                      {s.op.payload.provisionalNumber}
                    </button>
                  </td>
                  <td>{nameOf(s.op.payload.memberId)}</td>
                  <td>
                    <Status e={s} />
                    {s.status === 'REJECTED' ? (
                      <span className="block text-xs text-destructive">{s.lastError}</span>
                    ) : null}
                    {s.result?.warnings.length ? (
                      <span className="block text-xs text-warning">
                        {s.result.warnings.map((w) => w.message).join(' ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-right tabular-nums">{formatEuro(s.op.payload.total)}</td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>

      <Dialog
        open={!!selected}
        onClose={() => setSelected(null)}
        title={`Ticket ${selected?.op.payload.provisionalNumber ?? ''}`}
        className="max-w-xl"
      >
        {selected ? (
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">
              {formatDateTime(selected.op.payload.soldAt)} · {nameOf(selected.op.payload.memberId)}
              {selected.result?.number ? ` · n° définitif ${selected.result.number}` : ''}
            </p>
            <Table>
              <tbody>
                {selected.op.payload.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.label}</td>
                    <td className="text-right tabular-nums">
                      {formatQty(parseQtyToMilli(l.qty) ?? 0)}
                    </td>
                    <td className="text-right tabular-nums">{formatEuro(l.unitPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p>
              {selected.op.payload.payments
                .map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatEuro(p.amount)}`)
                .join(' · ')}
            </p>
            <p className="text-base font-semibold">Total {formatEuro(selected.op.payload.total)}</p>
            {!cancelled.has(selected.id) && selected.status !== 'REJECTED' ? (
              <div className="grid gap-2 rounded-md border p-3">
                <Field label="Motif de l’annulation">
                  {(p) => (
                    <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />
                  )}
                </Field>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Annuler ce ticket ? Un ticket d’annulation inverse le stock et la cagnotte (R-VTE-12).',
                      )
                    )
                      void cancel(selected);
                  }}
                >
                  <Ban /> Annuler ce ticket
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
