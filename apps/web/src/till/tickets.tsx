import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Ban, CheckCircle2, Clock, RotateCcw, XCircle } from 'lucide-react';
import {
  formatEuro,
  formatQty,
  parseQtyToMilli,
  PAYMENT_METHOD_LABELS,
  provisionalNumber,
  type SyncOp,
} from '@episoft/shared';
import { formatDateTime } from '@/lib/utils';
import { confirmNow } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input } from '@/components/ui/form';
import { NoMatchRow, SortTh, useSort } from '@/components/ui/sortable';
import { tillDb, type OutboxEntry } from './db';
import { useTill } from './context';
import { enqueue } from './sync';
import { draftFromSale } from './drafts';
import { linesFromSale } from './logic';

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
        {e.acknowledged ? 'Refusé (classé)' : 'Refusé'}
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
  const navigate = useNavigate();

  const sessionId = meta.session?.id;
  const sales = (entries ?? []).filter(
    (e): e is SaleEntry => e.op.kind === 'SALE' && e.op.payload.sessionId === sessionId,
  );
  const cancelled = new Set(
    (entries ?? []).flatMap((e) =>
      e.op.kind === 'SALE_CANCEL' && e.status !== 'REJECTED' ? [e.op.payload.saleId] : [],
    ),
  );
  const others = (entries ?? []).filter(
    (e) => e.op.kind !== 'SALE' && e.status === 'REJECTED' && !e.acknowledged,
  );
  const nameOf = (id: string | null) => {
    const m = (members ?? []).find((x) => x.id === id);
    return m ? `${m.firstName} ${m.lastName}` : 'Sans adhérent';
  };

  const accessors = useMemo(
    () => ({
      at: (s: SaleEntry) => s.op.payload.soldAt,
      number: (s: SaleEntry) => s.op.payload.provisionalNumber,
      member: (s: SaleEntry) => nameOf(s.op.payload.memberId),
      status: (s: SaleEntry) =>
        cancelled.has(s.id)
          ? 'Annulé'
          : s.status === 'PENDING'
            ? 'En attente'
            : s.status === 'REJECTED'
              ? 'Refusé'
              : (s.result?.number ?? 'Envoyé'),
      total: (s: SaleEntry) => Number(s.op.payload.total),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, entries],
  );
  const sort = useSort(sales, accessors);
  /** A refused ticket goes back into a new draft, to be checked and paid again. */
  const reenter = async (s: SaleEntry) => {
    await draftFromSale(linesFromSale(s.op.payload), s.op.payload.memberId);
    await tillDb.outbox.update(s.id, { acknowledged: true });
    setSelected(null);
    await navigate({ to: '/caisse' });
  };
  const putAside = async (s: SaleEntry) => {
    await tillDb.outbox.update(s.id, { acknowledged: true });
    setSelected(null);
  };
  if (!entries || !members) return <p className="p-6 text-muted-foreground">Chargement…</p>;

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
            <span key={o.id} className="flex flex-wrap items-center gap-2">
              Opération refusée ({o.kind}) : {o.lastError}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void tillDb.outbox.update(o.id, { acknowledged: true })}
              >
                Classer
              </Button>
            </span>
          ))}
        </Alert>
      ) : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="at">
                Heure
              </SortTh>
              <SortTh state={sort} sortKey="number">
                N° provisoire
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
            {sales.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucun ticket dans cette session.
                </td>
              </tr>
            ) : (
              (sort.rows ?? []).map((s) => (
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
          <NoMatchRow state={sort} total={sales.length} />
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
            {selected.status === 'REJECTED' ? (
              <div className="grid gap-2 rounded-md border border-destructive/40 p-3">
                <p className="font-medium text-destructive">
                  Ce ticket n’a pas été enregistré : {selected.lastError}
                </p>
                <p className="text-muted-foreground">
                  Le stock et la cagnotte n’ont pas bougé. Ressaisissez-le pour l’encaisser à
                  nouveau, ou classez-le si le client est déjà passé en caisse autrement.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void reenter(selected)}>
                    <RotateCcw /> Ressaisir ce ticket
                  </Button>
                  <Button variant="outline" onClick={() => void putAside(selected)}>
                    Classer sans suite
                  </Button>
                </div>
              </div>
            ) : null}
            {!cancelled.has(selected.id) && selected.status !== 'REJECTED' ? (
              <div className="grid gap-2 rounded-md border p-3">
                <Field label="Motif de l’annulation">
                  {(p) => (
                    <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />
                  )}
                </Field>
                <Button
                  variant="destructive"
                  onClick={async () => {
                    if (
                      await confirmNow({
                        title: 'Annuler ce ticket ?',
                        message:
                          'Un ticket d’annulation est créé : il remet le stock et la cagnotte comme avant la vente.',
                        confirmLabel: 'Annuler le ticket',
                        cancelLabel: 'Garder le ticket',
                        destructive: true,
                      })
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
