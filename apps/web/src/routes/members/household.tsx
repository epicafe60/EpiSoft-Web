import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePlus, FileSpreadsheet, Mail, Minus, Plus } from 'lucide-react';
import {
  MEMBER_PAYMENT_METHODS,
  MEMBER_PAYMENT_PURPOSE_LABELS,
  MEMBER_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  WALLET_ENTRY_KIND_LABELS,
  type MemberPaymentMethod,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { euro, formatDate, todayIso } from '@/lib/format';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import type { HouseholdDetail, MembershipTypeRow, SaleListItem } from '@/lib/types';
import { NoMatchRow, SortTh, useSort } from '@/components/ui/sortable';

type WalletRow = HouseholdDetail['wallet'][number];
const WALLET_SORT = {
  at: (w: WalletRow) => w.at,
  kind: (w: WalletRow) =>
    `${WALLET_ENTRY_KIND_LABELS[w.kind]} ${w.paymentMethod ? PAYMENT_METHOD_LABELS[w.paymentMethod] : ''}`,
  detail: (w: WalletRow) =>
    `${w.saleNumber ? `Ticket ${w.saleNumber}` : (w.comment ?? '')} ${w.byName ?? ''}`,
  amount: (w: WalletRow) => Number(w.amount),
};
import { PageHeader } from '../shell';
import { QueryError } from '../errors';
import { MembershipBadge } from './list';
import { SaleDialog } from './sale-dialog';

const methodOptions = MEMBER_PAYMENT_METHODS.map((m) => (
  <option key={m} value={m}>
    {PAYMENT_METHOD_LABELS[m]}
  </option>
));

/** A small form in a dialog, posting to the household and refreshing it. */
function ActionDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: () => Promise<unknown>;
  children: (errors: Record<string, string>) => ReactNode;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await onSubmit();
      setErrors({});
      setError(null);
      onClose();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.fieldErrors() : {});
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <form onSubmit={submit} className="grid gap-4">
        {children(errors)}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function HouseholdPage() {
  const { id } = useParams({ from: '/app/foyers/$id' });
  const queryClient = useQueryClient();
  const {
    data: h,
    error,
    isPending,
  } = useQuery({
    queryKey: ['household', id],
    queryFn: () => api.get<HouseholdDetail>(`/households/${id}`),
  });
  const sales = useQuery({
    queryKey: ['sales', 'household', id],
    queryFn: () => api.get<SaleListItem[]>(`/pos/sales?householdId=${id}&limit=50`),
  });
  const types = useQuery({
    queryKey: ['membership-types'],
    queryFn: () => api.get<MembershipTypeRow[]>('/membership-types'),
    staleTime: 60_000,
  });
  const [dialog, setDialog] = useState<'topup' | 'correction' | 'membership' | 'info' | null>(null);
  const [saleId, setSaleId] = useState<string | null>(null);

  // Dialog fields
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<MemberPaymentMethod>('CASH');
  const [comment, setComment] = useState('');
  const [receipt, setReceipt] = useState(true);
  const [typeId, setTypeId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [info, setInfo] = useState({ transferReference: '', notes: '', referentMemberId: '' });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['household', id] }),
      queryClient.invalidateQueries({ queryKey: ['members'] }),
    ]);
  const open = (d: typeof dialog) => {
    setAmount('');
    setComment('');
    setMethod('CASH');
    setDate(todayIso());
    if (d === 'membership')
      setTypeId(types.data?.find((t) => t.active && t.durationMonths > 0)?.id ?? '');
    if (d === 'info' && h)
      setInfo({
        transferReference: h.transferReference ?? '',
        notes: h.notes ?? '',
        referentMemberId: h.referentMemberId ?? '',
      });
    setDialog(d);
  };
  const close = () => setDialog(null);
  const sendHistory = useMutation({ mutationFn: () => api.post(`/households/${id}/wallet/email`) });
  const cancelTopup = useMutation({
    mutationFn: (entryId: string) => api.post(`/wallet-entries/${entryId}/cancel`),
    onSuccess: refresh,
  });
  const saveInfo = useMutation({
    mutationFn: () =>
      api.patch(`/households/${id}`, {
        ...info,
        referentMemberId: info.referentMemberId || undefined,
        updatedAt: h!.updatedAt,
      }),
    onSuccess: refresh,
  });

  const walletSort = useSort(h?.wallet, WALLET_SORT);
  if (isPending) return <p className="text-muted-foreground">Chargement…</p>;
  if (error) return <QueryError error={error} />;
  const membershipEnd = h.memberships.find((m) => !m.cancelledAt)?.endDate ?? null;
  const negative = h.balance.startsWith('-');

  return (
    <>
      <PageHeader
        title={`Foyer n° ${h.number}`}
        description={h.members.map((m) => `${m.firstName} ${m.lastName}`).join(', ')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => open('topup')}>
              <Plus /> Versement
            </Button>
            <Button variant="outline" onClick={() => open('membership')}>
              <BadgePlus /> Adhésion
            </Button>
            <Button variant="outline" onClick={() => open('correction')}>
              <Minus /> Correction
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">Solde de la cagnotte</p>
            <p
              className={`text-3xl font-semibold tabular-nums ${negative ? 'text-destructive' : ''}`}
            >
              {euro(h.balance)}
            </p>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">Adhésion</p>
            <div>
              <MembershipBadge end={membershipEnd} />
            </div>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">Référence de virement</p>
            <p className="font-medium">{h.transferReference ?? '—'}</p>
            <button
              type="button"
              className="justify-self-start text-sm text-primary hover:underline"
              onClick={() => open('info')}
            >
              Modifier le foyer
            </button>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Membres</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {h.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/membres/$id"
                    params={{ id: m.id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {m.firstName} {m.lastName}
                  </Link>
                  <span className="text-xs text-muted-foreground">n° {m.number}</span>
                  {m.id === h.referentMemberId ? <Badge>Référent</Badge> : null}
                  {m.status !== 'ACTIVE' ? (
                    <Badge variant="muted">{MEMBER_STATUS_LABELS[m.status]}</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
            {h.notes ? (
              <p className="mt-4 whitespace-pre-line rounded-md bg-muted p-3 text-sm">{h.notes}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Adhésions</CardTitle>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Du</th>
                <th>Au</th>
                <th className="text-right">Montant</th>
              </tr>
            </thead>
            <tbody>
              {h.memberships.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-muted-foreground">
                    Aucune adhésion.
                  </td>
                </tr>
              ) : (
                h.memberships.map((m) => (
                  <tr
                    key={m.id}
                    className={m.cancelledAt ? 'text-muted-foreground line-through' : ''}
                  >
                    <td>{m.type}</td>
                    <td className="tabular-nums">{formatDate(m.startDate)}</td>
                    <td className="tabular-nums">{formatDate(m.endDate)}</td>
                    <td className="text-right tabular-nums">{euro(m.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row flex-wrap items-center justify-between">
            <CardTitle className="text-base">Opérations de cagnotte</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {sendHistory.isSuccess ? (
                <span className="text-sm text-success">Historique envoyé.</span>
              ) : null}
              {sendHistory.error ? (
                <span className="text-sm text-destructive">{sendHistory.error.message}</span>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => sendHistory.mutate()}
                disabled={sendHistory.isPending}
              >
                <Mail /> Envoyer par courriel
              </Button>
              <a
                className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
                href={`/api/v1/households/${id}/wallet.xlsx`}
              >
                <FileSpreadsheet className="size-4" /> Excel
              </a>
            </div>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <SortTh state={walletSort} sortKey="at">
                  Date
                </SortTh>
                <SortTh state={walletSort} sortKey="kind">
                  Opération
                </SortTh>
                <SortTh state={walletSort} sortKey="detail">
                  Détail
                </SortTh>
                <SortTh state={walletSort} sortKey="amount" className="text-right">
                  Montant
                </SortTh>
              </tr>
            </thead>
            <tbody>
              {h.wallet.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-muted-foreground">
                    Aucune opération.
                  </td>
                </tr>
              ) : (
                (walletSort.rows ?? []).map((w) => (
                  <tr key={w.id}>
                    <td className="whitespace-nowrap tabular-nums">{formatDateTime(w.at)}</td>
                    <td>
                      {WALLET_ENTRY_KIND_LABELS[w.kind]}
                      {w.paymentMethod ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · {PAYMENT_METHOD_LABELS[w.paymentMethod]}
                        </span>
                      ) : null}
                      {w.cancellable ? (
                        <button
                          type="button"
                          className="ml-2 text-xs text-destructive hover:underline"
                          onClick={() => {
                            if (
                              window.confirm('Annuler ce versement saisi aujourd’hui (R-CAG-08) ?')
                            )
                              cancelTopup.mutate(w.id);
                          }}
                        >
                          annuler
                        </button>
                      ) : null}
                      {w.forced ? (
                        <Badge variant="destructive" className="ml-2">
                          découvert forcé
                        </Badge>
                      ) : null}
                    </td>
                    <td className="text-muted-foreground">
                      {w.saleId ? (
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setSaleId(w.saleId)}
                        >
                          Ticket {w.saleNumber}
                        </button>
                      ) : (
                        w.comment
                      )}
                      {w.byName ? <span className="block text-xs">par {w.byName}</span> : null}
                    </td>
                    <td
                      className={`text-right tabular-nums ${w.amount.startsWith('-') ? 'text-destructive' : 'text-success'}`}
                    >
                      {euro(w.amount)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <NoMatchRow state={walletSort} total={h.wallet.length} />
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Derniers tickets</CardTitle>
          </CardHeader>
          <Table>
            <tbody>
              {(sales.data ?? []).map((s) => (
                <tr
                  key={s.id}
                  className={s.status === 'CANCELLED' ? 'text-muted-foreground line-through' : ''}
                >
                  <td className="whitespace-nowrap tabular-nums">{formatDateTime(s.soldAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setSaleId(s.id)}
                    >
                      {s.number}
                    </button>
                    <span className="block text-xs text-muted-foreground">{s.memberName}</span>
                  </td>
                  <td className="text-right tabular-nums">{euro(s.total)}</td>
                </tr>
              ))}
              {sales.data?.length === 0 ? (
                <tr>
                  <td className="text-muted-foreground">Aucun ticket.</td>
                </tr>
              ) : null}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paiements</CardTitle>
          </CardHeader>
          <Table>
            <tbody>
              {h.payments.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap tabular-nums">{formatDate(p.date)}</td>
                  <td>
                    {MEMBER_PAYMENT_PURPOSE_LABELS[p.purpose]}
                    <span className="block text-xs text-muted-foreground">
                      {p.method ? PAYMENT_METHOD_LABELS[p.method] : 'mode inconnu'}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{euro(p.amount)}</td>
                </tr>
              ))}
              {h.payments.length === 0 ? (
                <tr>
                  <td className="text-muted-foreground">Aucun paiement.</td>
                </tr>
              ) : null}
            </tbody>
          </Table>
        </Card>
      </div>

      <ActionDialog
        open={dialog === 'topup'}
        onClose={close}
        title="Versement sur la cagnotte"
        submitLabel="Enregistrer le versement"
        onSubmit={() =>
          api
            .post(`/households/${id}/wallet/topup`, {
              amount,
              method,
              date,
              comment,
              emailReceipt: receipt,
            })
            .then(refresh)
        }
      >
        {(errors) => (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Montant (€)" error={errors.amount}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    autoFocus
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Mode" error={errors.method}>
                {(p) => (
                  <Select
                    {...p}
                    value={method}
                    onChange={(e) => setMethod(e.target.value as MemberPaymentMethod)}
                  >
                    {methodOptions}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Date" error={errors.date}>
              {(p) => (
                <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              )}
            </Field>
            <Field label="Commentaire">
              {(p) => <Input {...p} value={comment} onChange={(e) => setComment(e.target.value)} />}
            </Field>
            <div className="flex items-center gap-2">
              <Checkbox
                id="receipt"
                checked={receipt}
                onChange={(e) => setReceipt(e.target.checked)}
              />
              <Label htmlFor="receipt" className="font-normal">
                Envoyer le reçu par courriel (R-CAG-06)
              </Label>
            </div>
          </>
        )}
      </ActionDialog>

      <ActionDialog
        open={dialog === 'correction'}
        onClose={close}
        title="Correction de cagnotte"
        description="Montant positif pour créditer, négatif pour débiter. Le motif est obligatoire et la correction est journalisée."
        submitLabel="Enregistrer la correction"
        onSubmit={() =>
          api.post(`/households/${id}/wallet/correction`, { amount, comment }).then(refresh)
        }
      >
        {(errors) => (
          <>
            <Field label="Montant (€)" error={errors.amount}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  autoFocus
                  placeholder="-5,00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </Field>
            <Field label="Motif" error={errors.comment}>
              {(p) => (
                <Textarea {...p} value={comment} onChange={(e) => setComment(e.target.value)} />
              )}
            </Field>
          </>
        )}
      </ActionDialog>

      <ActionDialog
        open={dialog === 'membership'}
        onClose={close}
        title="Enregistrer une adhésion"
        description="Un renouvellement commence le lendemain de la fin de l’adhésion en cours."
        submitLabel="Enregistrer l’adhésion"
        onSubmit={() =>
          api.post(`/households/${id}/memberships`, { typeId, method, date }).then(refresh)
        }
      >
        {(errors) => (
          <>
            <Field label="Type" error={errors.typeId}>
              {(p) => (
                <Select {...p} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                  {(types.data ?? [])
                    .filter((t) => t.active)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} — {euro(t.price)}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Mode de paiement">
                {(p) => (
                  <Select
                    {...p}
                    value={method}
                    onChange={(e) => setMethod(e.target.value as MemberPaymentMethod)}
                  >
                    {methodOptions}
                  </Select>
                )}
              </Field>
              <Field label="Date" error={errors.date}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </>
        )}
      </ActionDialog>

      <ActionDialog
        open={dialog === 'info'}
        onClose={close}
        title="Foyer"
        submitLabel="Enregistrer"
        onSubmit={() => saveInfo.mutateAsync()}
      >
        {(errors) => (
          <>
            <Field label="Membre référent" error={errors.referentMemberId}>
              {(p) => (
                <Select
                  {...p}
                  value={info.referentMemberId}
                  onChange={(e) => setInfo({ ...info, referentMemberId: e.target.value })}
                >
                  {h.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.firstName} {m.lastName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Référence de virement"
              hint="Sert à affecter automatiquement les virements reçus (R-MBR-04)."
              error={errors.transferReference}
            >
              {(p) => (
                <Input
                  {...p}
                  value={info.transferReference}
                  onChange={(e) => setInfo({ ...info, transferReference: e.target.value })}
                />
              )}
            </Field>
            <Field label="Notes" error={errors.notes}>
              {(p) => (
                <Textarea
                  {...p}
                  value={info.notes}
                  onChange={(e) => setInfo({ ...info, notes: e.target.value })}
                />
              )}
            </Field>
          </>
        )}
      </ActionDialog>

      <SaleDialog saleId={saleId} onClose={() => setSaleId(null)} />
    </>
  );
}
