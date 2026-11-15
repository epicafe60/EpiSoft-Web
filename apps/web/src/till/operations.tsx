import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { Ban, CheckCircle2, Clock, RotateCcw, XCircle } from 'lucide-react';
import {
  centsToDecimal,
  decimalToCents,
  filterOperations,
  formatEuro,
  formatQty,
  OPERATION_TYPES,
  OPERATION_TYPE_LABELS,
  operationTotals,
  parseQtyToMilli,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  provisionalNumber,
  type OperationFilter,
  type OperationRow,
} from '@episoft/shared';
import { api } from '@/lib/api';
import type { SaleDetail } from '@/lib/types';
import { cn, formatDateTime } from '@/lib/utils';
import { confirmNow } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { tillDb, type OutboxEntry } from './db';
import { useTill } from './context';
import { enqueue } from './sync';
import { draftFromSale } from './drafts';
import { linesFromSale } from './logic';
import {
  cancelledSaleIds,
  localOperations,
  mergeOperations,
  type LocalOperationRow,
  type OperationScope,
} from './operations-rows';

type SaleEntry = OutboxEntry & { op: Extract<OutboxEntry['op'], { kind: 'SALE' }> };

const cents = (v: string) => decimalToCents(v);

/** A cagnotte movement: green when it adds, orange when it takes. The « + » is for the eye only. */
function Signed({ value }: { value: string }) {
  const c = cents(value);
  if (c === 0) return null;
  return (
    <span className={cn('tabular-nums', c > 0 ? 'text-success' : 'text-warning')}>
      {c > 0 ? <span data-no-export>+</span> : null}
      {formatEuro(value)}
    </span>
  );
}

/** An amount that is left empty when there is nothing in it. */
const Amount = ({ value }: { value: string }) =>
  cents(value) === 0 ? null : <span className="tabular-nums">{formatEuro(value)}</span>;

function Payments({ payments }: { payments: OperationRow['payments'] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {payments.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-muted-foreground">·</span> : null}
          <Badge variant="muted" className="whitespace-nowrap tabular-nums">
            {PAYMENT_METHOD_LABELS[p.method]} {formatEuro(p.amount)}
          </Badge>
        </span>
      ))}
    </span>
  );
}

function Status({ r }: { r: LocalOperationRow }) {
  if (r.cancelled) return <Badge variant="muted">Annulé</Badge>;
  if (r.sync === 'PENDING')
    return (
      <Badge variant="muted">
        <Clock className="mr-1 size-3" />
        En attente
      </Badge>
    );
  if (r.sync === 'REJECTED')
    return (
      <Badge variant="destructive">
        <XCircle className="mr-1 size-3" />
        {r.acknowledged ? 'Refusé (classé)' : 'Refusé'}
      </Badge>
    );
  return (
    <Badge variant="success">
      <CheckCircle2 className="mr-1 size-3" />
      Envoyé
    </Badge>
  );
}

/**
 * The operations of the session (or of the whole day): the tickets and the payments made outside a
 * ticket, one per line. The till reads its own queue, so the page works offline; online it adds
 * what the other tills did, read from the server.
 */
export function OperationsPage() {
  const { meta, cashierId, cashierCheck, cashierProof, engine, sync } = useTill();
  const entries = useLiveQuery(() => tillDb.outbox.orderBy('seq').reverse().toArray(), []);
  const members = useLiveQuery(() => tillDb.members.toArray(), []);
  const products = useLiveQuery(() => tillDb.products.toArray(), []);
  const membershipTypes = useLiveQuery(() => tillDb.membershipTypes.toArray(), []);
  const [selected, setSelected] = useState<SaleEntry | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [payment, setPayment] = useState<LocalOperationRow | null>(null);
  const [reason, setReason] = useState('');
  const [wholeDay, setWholeDay] = useState(false);
  const [filter, setFilter] = useState<OperationFilter>({});
  const navigate = useNavigate();

  const sessionId = meta.session?.id;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  // Without a session open, the only thing to show is the day.
  const byDay = wholeDay || !sessionId;
  const scope: OperationScope = byDay ? { day: today } : { sessionId: sessionId! };

  const server = useQuery({
    queryKey: ['till-operations', scope],
    queryFn: () =>
      api.get<OperationRow[]>(
        `/pos/operations?${'day' in scope ? `day=${scope.day}` : `sessionId=${scope.sessionId}`}`,
      ),
    enabled: sync.online,
    refetchInterval: 15_000,
  });

  const cancelledIds = useMemo(() => cancelledSaleIds(entries ?? []), [entries]);
  const all = useMemo(() => {
    if (!entries || !members || !products || !membershipTypes) return null;
    const local = localOperations({ entries, products, membershipTypes, members, scope });
    return mergeOperations(sync.online ? server.data : undefined, local, cancelledIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entries,
    members,
    products,
    membershipTypes,
    sync.online,
    server.data,
    cancelledIds,
    byDay,
    sessionId,
    today,
  ]);
  const rows = useMemo(() => (all ? filterOperations(all, filter) : []), [all, filter]);
  // A ticket the server refused never happened: it is in the list, not in the totals.
  const totals = useMemo(() => operationTotals(rows.filter((r) => r.sync !== 'REJECTED')), [rows]);
  const cashiers = useMemo(
    () => [...new Set((all ?? []).flatMap((r) => (r.cashierName ? [r.cashierName] : [])))].sort(),
    [all],
  );

  const others = (entries ?? []).filter(
    (e) => e.op.kind !== 'SALE' && e.status === 'REJECTED' && !e.acknowledged,
  );
  const entryById = (id: string) => (entries ?? []).find((e) => e.id === id);
  const nameOf = (id: string | null) => {
    const m = (members ?? []).find((x) => x.id === id);
    return m ? `${m.firstName} ${m.lastName}` : 'Sans adhérent';
  };

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
  const cancelSale = async (saleId: string) => {
    await enqueue((deviceSeq) => ({
      kind: 'SALE_CANCEL',
      id: crypto.randomUUID(),
      deviceSeq,
      payload: {
        cancelSaleId: crypto.randomUUID(),
        saleId,
        sessionId: sessionId!,
        cashierId,
        cashierCheck,
        ...(cashierProof ? { cashierProof } : {}),
        at: new Date().toISOString(),
        provisionalNumber: provisionalNumber(meta.device!.name, deviceSeq),
        reason: reason.trim() || undefined,
      },
    }));
    engine.kick();
    setSelected(null);
    setOpenId(null);
    setReason('');
  };

  const open = (r: LocalOperationRow) => {
    const e = r.type === 'SALE' ? entryById(r.id) : undefined;
    if (e && e.op.kind === 'SALE') setSelected(e as SaleEntry);
    else if (r.type === 'SALE') setOpenId(r.id);
    else setPayment(r);
  };

  if (!all) return <p className="p-6 text-muted-foreground">Chargement…</p>;

  const set = (patch: Partial<OperationFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const title = byDay ? 'Opérations de la journée' : 'Opérations de la session';
  const COLS = 11;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4">
      <h1 className="text-xl font-semibold">{title}</h1>
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          aria-label="Type d’opération"
          value={filter.type ?? ''}
          onChange={(e) => set({ type: e.target.value as OperationFilter['type'] })}
        >
          <option value="">Tous les types</option>
          {OPERATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {OPERATION_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Encaissé par"
          value={filter.cashier ?? ''}
          onChange={(e) => set({ cashier: e.target.value })}
        >
          <option value="">Tous les caissiers</option>
          {cashiers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Moyen de paiement"
          value={filter.method ?? ''}
          onChange={(e) => set({ method: e.target.value as OperationFilter['method'] })}
        >
          <option value="">Tous les moyens de paiement</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABELS[m]}
            </option>
          ))}
        </Select>
        <Input
          type="search"
          aria-label="Rechercher une opération"
          placeholder="N°, adhérent, caissier…"
          value={filter.q ?? ''}
          onChange={(e) => set({ q: e.target.value })}
        />
      </div>
      {sessionId ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={wholeDay} onChange={(e) => setWholeDay(e.target.checked)} />
          Toute la journée (tous les postes)
        </label>
      ) : null}
      {!sync.online ? (
        <p className="text-sm text-muted-foreground">
          Hors ligne : seules les opérations de ce poste sont affichées.
        </p>
      ) : null}

      <Card>
        <Table exportName={title}>
          <thead>
            <tr>
              <th>Heure</th>
              <th>N°</th>
              <th>Type</th>
              <th>Encaissé par</th>
              <th>Adhérent</th>
              <th>Paiement</th>
              <th className="text-right">Montant total</th>
              <th className="hidden text-right lg:table-cell">dont Don</th>
              <th className="hidden text-right lg:table-cell">dont Adhésion</th>
              <th className="hidden text-right lg:table-cell">Mouvement de cagnotte</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLS} className="text-muted-foreground">
                  {all.length === 0
                    ? `Aucune opération dans ${byDay ? 'cette journée' : 'cette session'}.`
                    : 'Aucune opération ne correspond aux filtres.'}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const e = entryById(r.id);
                return (
                  <tr
                    key={r.id}
                    className={cn(r.cancelled && 'text-muted-foreground line-through')}
                  >
                    <td className="tabular-nums">{formatDateTime(r.at)}</td>
                    <td>
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => open(r)}
                      >
                        {r.number ?? 'Voir'}
                      </button>
                    </td>
                    <td>{OPERATION_TYPE_LABELS[r.type]}</td>
                    <td>
                      {r.cashierName ?? '—'}
                      {r.deviceName && r.deviceName !== meta.device?.name ? (
                        <div className="text-xs text-muted-foreground">{r.deviceName}</div>
                      ) : null}
                    </td>
                    <td>{r.memberName ?? (r.type === 'SALE' ? 'Sans adhérent' : '')}</td>
                    <td>
                      <Payments payments={r.payments} />
                    </td>
                    <td className="text-right tabular-nums">
                      {formatEuro(r.total)}
                      <div
                        className="mt-1 flex flex-col items-end text-xs lg:hidden"
                        data-no-export
                      >
                        {cents(r.donation) ? <span>dont don {formatEuro(r.donation)}</span> : null}
                        {cents(r.membership) ? (
                          <span>dont adhésion {formatEuro(r.membership)}</span>
                        ) : null}
                        {cents(r.wallet) ? (
                          <span className={cents(r.wallet) > 0 ? 'text-success' : 'text-warning'}>
                            cagnotte {cents(r.wallet) > 0 ? '+' : ''}
                            {formatEuro(r.wallet)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="hidden text-right lg:table-cell">
                      <Amount value={r.donation} />
                    </td>
                    <td className="hidden text-right lg:table-cell">
                      <Amount value={r.membership} />
                    </td>
                    <td className="hidden text-right lg:table-cell">
                      <Signed value={r.wallet} />
                    </td>
                    <td>
                      <Status r={r} />
                      {r.sync === 'REJECTED' && r.error ? (
                        <span className="block text-xs text-destructive">{r.error}</span>
                      ) : null}
                      {e?.result?.warnings.length ? (
                        <span className="block text-xs text-warning">
                          {e.result.warnings.map((w) => w.message).join(' ')}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot className="border-t-2 font-medium">
            <tr>
              <td colSpan={6}>
                Total ({totals.count} opération{totals.count > 1 ? 's' : ''}, annulations et refus
                exclus)
              </td>
              <td className="text-right tabular-nums">
                {formatEuro(centsToDecimal(cents(totals.sales) + cents(totals.payments)))}
              </td>
              <td className="hidden text-right tabular-nums lg:table-cell">
                {formatEuro(totals.donation)}
              </td>
              <td className="hidden text-right tabular-nums lg:table-cell">
                {formatEuro(totals.membership)}
              </td>
              <td className="hidden text-right tabular-nums lg:table-cell">
                {cents(totals.wallet) === 0 ? formatEuro('0') : <Signed value={totals.wallet} />}
              </td>
              <td />
            </tr>
            <tr className="text-muted-foreground">
              <td colSpan={COLS} className="font-normal">
                <span className="mr-4">Ventes {formatEuro(totals.sales)}</span>
                <span className="mr-4">
                  Rechargements et versements {formatEuro(totals.payments)}
                </span>
                <span className="mr-4 lg:hidden">
                  Don {formatEuro(totals.donation)} · Adhésion {formatEuro(totals.membership)} ·
                  Cagnotte {cents(totals.wallet) > 0 ? '+' : ''}
                  {formatEuro(totals.wallet)}
                </span>
                <br />
                {PAYMENT_METHODS.filter((m) => cents(totals.byMethod[m]) !== 0).map((m) => (
                  <span key={m} className="mr-4 tabular-nums">
                    {PAYMENT_METHOD_LABELS[m]} {formatEuro(totals.byMethod[m])}
                  </span>
                ))}
              </td>
            </tr>
          </tfoot>
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
            <Table exportable={false}>
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
            {!cancelledIds.has(selected.id) && selected.status !== 'REJECTED' ? (
              <CancelBox
                reason={reason}
                setReason={setReason}
                onCancel={() => cancelSale(selected.id)}
              />
            ) : null}
          </div>
        ) : null}
      </Dialog>

      <ServerTicketDialog
        openId={openId}
        onClose={() => setOpenId(null)}
        online={sync.online}
        sessionId={sessionId}
        cancelledIds={cancelledIds}
        onCancel={cancelSale}
        reason={reason}
        setReason={setReason}
      />

      <Dialog
        open={!!payment}
        onClose={() => setPayment(null)}
        title={payment ? OPERATION_TYPE_LABELS[payment.type] : ''}
        className="max-w-md"
      >
        {payment ? (
          <div className="grid gap-2 text-sm">
            <p>
              <span className="text-muted-foreground">Foyer : </span>
              {payment.memberName ?? '—'}
            </p>
            <p>
              <span className="text-muted-foreground">Montant : </span>
              <span className="font-semibold tabular-nums">{formatEuro(payment.total)}</span>
            </p>
            <p>
              <span className="text-muted-foreground">Mode : </span>
              {payment.payments.map((p) => PAYMENT_METHOD_LABELS[p.method]).join(', ') || '—'}
            </p>
            <p>
              <span className="text-muted-foreground">Encaissé par : </span>
              {payment.cashierName ?? '—'}
              {payment.deviceName ? ` (${payment.deviceName})` : ''}
            </p>
            <p>
              <span className="text-muted-foreground">Le : </span>
              {formatDateTime(payment.at)}
            </p>
            {payment.cancelled ? (
              <p className="text-muted-foreground">Ce versement est annulé.</p>
            ) : null}
            {payment.sync === 'PENDING' ? (
              <p className="text-muted-foreground">En attente d’envoi au serveur.</p>
            ) : null}
            {payment.sync === 'REJECTED' ? (
              <p className="text-destructive">Refusé par le serveur : {payment.error}</p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function CancelBox({
  reason,
  setReason,
  onCancel,
}: {
  reason: string;
  setReason: (r: string) => void;
  onCancel: () => Promise<void>;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <Field label="Motif de l’annulation">
        {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
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
            await onCancel();
        }}
      >
        <Ban /> Annuler ce ticket
      </Button>
    </div>
  );
}

/**
 * A ticket another till made (a till only keeps its own in its queue): read from the server, so it
 * needs the network (R-EVO-06).
 */
function ServerTicketDialog({
  openId,
  onClose,
  online,
  sessionId,
  cancelledIds,
  onCancel,
  reason,
  setReason,
}: {
  openId: string | null;
  onClose: () => void;
  online: boolean;
  sessionId: string | undefined;
  cancelledIds: Set<string>;
  onCancel: (saleId: string) => Promise<void>;
  reason: string;
  setReason: (r: string) => void;
}) {
  const detail = useQuery({
    queryKey: ['till-sale', openId],
    queryFn: () => api.get<SaleDetail>(`/pos/sales/${openId}`),
    enabled: !!openId && online,
  });
  return (
    <Dialog
      open={!!openId}
      onClose={onClose}
      title={`Ticket ${detail.data?.number ?? ''}`}
      className="max-w-xl"
    >
      {detail.data ? (
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            {formatDateTime(detail.data.soldAt)} · {detail.data.cashierName ?? 'caissier inconnu'} ·{' '}
            {detail.data.memberName ?? 'Sans adhérent'}
          </p>
          <Table exportable={false}>
            <tbody>
              {detail.data.lines.map((l) => (
                <tr key={l.id}>
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
            {detail.data.payments
              .map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatEuro(p.amount)}`)
              .join(' · ')}
          </p>
          <p className="text-base font-semibold">Total {formatEuro(detail.data.total)}</p>
          {detail.data.cancelledBy || cancelledIds.has(detail.data.id) ? (
            <p className="text-muted-foreground">Ce ticket est annulé.</p>
          ) : detail.data.sessionId !== sessionId ? (
            <p className="text-muted-foreground">
              Ce ticket appartient à une autre session de caisse : seul un administrateur peut
              l’annuler (Administration).
            </p>
          ) : (
            <CancelBox
              reason={reason}
              setReason={setReason}
              onCancel={() => onCancel(detail.data!.id)}
            />
          )}
        </div>
      ) : (
        <p className="text-muted-foreground">
          {!online
            ? 'Le détail d’un ticket d’un autre poste s’affiche quand la caisse est en ligne.'
            : detail.error
              ? detail.error.message
              : 'Chargement…'}
        </p>
      )}
    </Dialog>
  );
}
