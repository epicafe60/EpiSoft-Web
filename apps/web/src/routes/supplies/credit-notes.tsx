import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet } from 'lucide-react';
import { api } from '@/lib/api';
import { euro, formatDate, todayIso } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import type { InvoiceRow, SupplierRow } from '@/lib/types-supplies';
import { QueryError } from '../errors';

interface CreditNoteRow {
  id: string;
  supplierId: string;
  supplierName: string;
  invoiceId: string | null;
  invoiceRef: string | null;
  pieceRef: string;
  date: string;
  totalExcl: string;
  totalVat: string;
  totalIncl: string;
  status: 'ACTIVE' | 'CANCELLED';
  allocated: string;
}

const remaining = (n: CreditNoteRow) =>
  (Math.round(Number(n.totalIncl) * 100) - Math.round(Number(n.allocated) * 100)) / 100;

/** A motif is mandatory for every correction of the books. */
function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  error?: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <div className="grid gap-3">
        <Field label="Motif (obligatoire, conservé au journal d’audit)">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {error ? <Alert>{error}</Alert> : null}
        <Button
          variant="destructive"
          disabled={pending || reason.trim().length < 5}
          onClick={() => onConfirm(reason.trim())}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/** Cancel the invoice, or reverse its payment, with a motif (never a deletion). */
export function InvoiceCorrections({
  invoiceId,
  status,
}: {
  invoiceId: string;
  status: 'TO_PAY' | 'PAID' | 'CANCELLED';
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'cancel' | 'reverse' | null>(null);
  const done = async () => {
    setMode(null);
    await queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    await queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };
  const cancel = useMutation({
    mutationFn: (reason: string) => api.post(`/supplier-invoices/${invoiceId}/cancel`, { reason }),
    onSuccess: done,
  });
  const reverse = useMutation({
    mutationFn: (reason: string) =>
      api.post(`/supplier-invoices/${invoiceId}/reverse-payment`, { reason }),
    onSuccess: done,
  });
  if (status === 'CANCELLED') return null;
  return (
    <div className="grid gap-2 border-t pt-3">
      <p className="text-xs text-muted-foreground">
        Une facture saisie par erreur ne se supprime pas : elle s’annule avec un motif, et son
        écriture est contre-passée.
      </p>
      <div className="flex flex-wrap gap-2">
        {status === 'PAID' ? (
          <Button variant="outline" size="sm" onClick={() => setMode('reverse')}>
            Annuler le règlement
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => setMode('cancel')}>
          Annuler la facture
        </Button>
      </div>
      <ReasonDialog
        open={mode === 'cancel'}
        title="Annuler cette facture ?"
        description="La facture reste visible, marquée annulée. Saisissez-la de nouveau avec les bons montants."
        confirmLabel="Annuler la facture"
        error={cancel.error?.message}
        pending={cancel.isPending}
        onClose={() => setMode(null)}
        onConfirm={(r) => cancel.mutate(r)}
      />
      <ReasonDialog
        open={mode === 'reverse'}
        title="Annuler le règlement ?"
        description="Une écriture inverse est passée ; la facture redevient à régler."
        confirmLabel="Annuler le règlement"
        error={reverse.error?.message}
        pending={reverse.isPending}
        onClose={() => setMode(null)}
        onConfirm={(r) => reverse.mutate(r)}
      />
    </div>
  );
}

/** Supplier credit notes (avoirs): list, entry, offset against an invoice to pay, cancel, Excel. */
export function CreditNotesPage() {
  const queryClient = useQueryClient();
  const notes = useQuery({
    queryKey: ['credit-notes'],
    queryFn: () => api.get<CreditNoteRow[]>('/supplier-credit-notes'),
  });
  const suppliers = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.get<SupplierRow[]>('/suppliers'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['credit-notes'] });

  const [supplierId, setSupplierId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [pieceRef, setPieceRef] = useState('');
  const [date, setDate] = useState(todayIso());
  const [totalExcl, setTotalExcl] = useState('');
  const [totalVat, setTotalVat] = useState('0');
  const [totalIncl, setTotalIncl] = useState('');
  const invoices = useQuery({
    queryKey: ['invoices', 'of-supplier', supplierId],
    queryFn: () => api.get<InvoiceRow[]>(`/supplier-invoices?supplierId=${supplierId}`),
    enabled: !!supplierId,
  });
  const create = useMutation({
    mutationFn: () =>
      api.post('/supplier-credit-notes', {
        supplierId,
        invoiceId: invoiceId || null,
        pieceRef,
        date,
        totalExcl,
        totalVat,
        totalIncl,
        comment: '',
      }),
    onSuccess: async () => {
      setPieceRef('');
      setTotalExcl('');
      setTotalVat('0');
      setTotalIncl('');
      setInvoiceId('');
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  const [applying, setApplying] = useState<CreditNoteRow | null>(null);
  const [cancelling, setCancelling] = useState<CreditNoteRow | null>(null);
  const toPay = useQuery({
    queryKey: ['invoices', 'to-pay', applying?.supplierId],
    queryFn: () =>
      api.get<InvoiceRow[]>(`/supplier-invoices?supplierId=${applying!.supplierId}&status=TO_PAY`),
    enabled: !!applying,
  });
  const [targetInvoice, setTargetInvoice] = useState('');
  const [amount, setAmount] = useState('');
  const apply = useMutation({
    mutationFn: () =>
      api.post(`/supplier-credit-notes/${applying!.id}/apply`, {
        invoiceId: targetInvoice,
        amount,
        date: todayIso(),
      }),
    onSuccess: async () => {
      setApplying(null);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['invoice'] });
    },
  });
  const cancel = useMutation({
    mutationFn: (reason: string) =>
      api.post(`/supplier-credit-notes/${cancelling!.id}/cancel`, { reason }),
    onSuccess: async () => {
      setCancelling(null);
      await refresh();
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Avoirs fournisseurs</CardTitle>
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href="/api/v1/supplier-credit-notes.xlsx"
          >
            <FileSpreadsheet /> Excel
          </a>
        </CardHeader>
        {notes.error ? <QueryError error={notes.error} /> : null}
        <Table>
          <thead>
            <tr>
              <th>Fournisseur</th>
              <th>Pièce</th>
              <th>Date</th>
              <th>Facture</th>
              <th className="text-right">TTC</th>
              <th className="text-right">Reste</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(notes.data ?? []).map((n) => (
              <tr key={n.id} className={n.status === 'CANCELLED' ? 'text-muted-foreground' : ''}>
                <td>{n.supplierName}</td>
                <td>{n.pieceRef}</td>
                <td>{formatDate(n.date)}</td>
                <td>{n.invoiceRef ?? '—'}</td>
                <td className="text-right tabular-nums">{euro(n.totalIncl)}</td>
                <td className="text-right tabular-nums">
                  {n.status === 'CANCELLED' ? (
                    <Badge variant="muted">Annulé</Badge>
                  ) : (
                    euro(remaining(n))
                  )}
                </td>
                <td className="text-right">
                  {n.status === 'ACTIVE' ? (
                    <div className="flex justify-end gap-2">
                      {remaining(n) > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setApplying(n);
                            setTargetInvoice('');
                            setAmount(String(remaining(n)));
                          }}
                        >
                          Imputer
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => setCancelling(n)}>
                        Annuler
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
            {notes.data && !notes.data.length ? (
              <tr>
                <td colSpan={7} className="text-center text-muted-foreground">
                  Aucun avoir.
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saisir un avoir</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={submit}>
            <Field label="Fournisseur">
              {(p) => (
                <Select
                  {...p}
                  value={supplierId}
                  onChange={(e) => {
                    setSupplierId(e.target.value);
                    setInvoiceId('');
                  }}
                >
                  <option value="">—</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Facture concernée"
              hint="Facultatif. Un avoir ne peut pas dépasser sa facture."
            >
              {(p) => (
                <Select {...p} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                  <option value="">Sans facture (remise, retour)</option>
                  {(invoices.data ?? [])
                    .filter((i) => i.status !== 'CANCELLED')
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.pieceRef} · {euro(i.totalIncl)}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label="N° de pièce">
              {(p) => (
                <Input {...p} value={pieceRef} onChange={(e) => setPieceRef(e.target.value)} />
              )}
            </Field>
            <Field label="Date">
              {(p) => (
                <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              )}
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="HT (€)">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={totalExcl}
                    onChange={(e) => setTotalExcl(e.target.value)}
                  />
                )}
              </Field>
              <Field label="TVA (€)">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={totalVat}
                    onChange={(e) => setTotalVat(e.target.value)}
                  />
                )}
              </Field>
              <Field label="TTC (€)">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={totalIncl}
                    onChange={(e) => setTotalIncl(e.target.value)}
                  />
                )}
              </Field>
            </div>
            {create.error ? <Alert>{create.error.message}</Alert> : null}
            <Button type="submit" disabled={create.isPending || !supplierId || !pieceRef}>
              Enregistrer l’avoir
            </Button>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={!!applying}
        onClose={() => setApplying(null)}
        title={`Imputer l’avoir ${applying?.pieceRef ?? ''}`}
        description="Le montant imputé vient en déduction de la facture à régler."
      >
        <div className="grid gap-3">
          <Field label="Facture à régler">
            {(p) => (
              <Select
                {...p}
                value={targetInvoice}
                onChange={(e) => setTargetInvoice(e.target.value)}
              >
                <option value="">—</option>
                {(toPay.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.pieceRef} · {euro(i.totalIncl)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Montant imputé (€)">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          {apply.error ? <Alert>{apply.error.message}</Alert> : null}
          <Button onClick={() => apply.mutate()} disabled={apply.isPending || !targetInvoice}>
            Imputer
          </Button>
        </div>
      </Dialog>
      <ReasonDialog
        open={!!cancelling}
        title={`Annuler l’avoir ${cancelling?.pieceRef ?? ''} ?`}
        description="Une écriture inverse est passée ; l’avoir reste visible, marqué annulé."
        confirmLabel="Annuler l’avoir"
        error={cancel.error?.message}
        pending={cancel.isPending}
        onClose={() => setCancelling(null)}
        onConfirm={(r) => cancel.mutate(r)}
      />
    </div>
  );
}
