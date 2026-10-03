import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Plus } from 'lucide-react';
import {
  centsToDecimal,
  invoiceDueDate,
  parseAmountToCents,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  SUPPLIER_PAYMENT_METHODS,
  type SupplierPaymentMethod,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { euro, formatDate, todayIso } from '@/lib/format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import type { InvoiceDetail, InvoiceRow, SupplierDetail, SupplierRow } from '@/lib/types-supplies';
import { QueryError } from '../errors';

const isDue = (d: string) => d <= todayIso();

export function InvoicesPage() {
  const [view, setView] = useState<'schedule' | 'all'>('schedule');
  const [supplierId, setSupplierId] = useState('');
  const suppliers = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.get<SupplierRow[]>('/suppliers'),
  });
  const params = new URLSearchParams(supplierId ? { supplierId } : {});
  if (view === 'schedule') params.set('status', 'TO_PAY');
  const { data, error } = useQuery({
    queryKey: ['invoices', params.toString()],
    queryFn: () => api.get<InvoiceRow[]>(`/supplier-invoices?${params}`),
  });
  const rows =
    view === 'schedule'
      ? [...(data ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      : (data ?? []);
  const total = rows
    .filter((r) => r.status === 'TO_PAY')
    .reduce((s, r) => s + Math.round(Number(r.totalIncl) * 100), 0);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label="Vue"
          className="w-56"
          value={view}
          onChange={(e) => setView(e.target.value as 'schedule' | 'all')}
        >
          <option value="schedule">Échéancier (à régler)</option>
          <option value="all">Toutes les factures</option>
        </Select>
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
        <Link to="/appros/factures/nouvelle" className={buttonVariants({ className: 'ml-auto' })}>
          <Plus /> Nouvelle facture
        </Link>
      </div>
      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <th>Échéance</th>
              <th>Fournisseur</th>
              <th>Pièce</th>
              <th>État</th>
              <th className="text-right">TTC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td
                  className={`tabular-nums ${r.status === 'TO_PAY' && isDue(r.dueDate) ? 'font-medium text-destructive' : ''}`}
                >
                  {formatDate(r.dueDate)}
                </td>
                <td>{r.supplierName}</td>
                <td>
                  <Link
                    to="/appros/factures/$id"
                    params={{ id: r.id }}
                    className="text-primary hover:underline"
                  >
                    {r.pieceRef}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    du {formatDate(r.date)}
                  </span>
                </td>
                <td>
                  {r.status === 'PAID' ? (
                    <Badge variant="success">Réglée</Badge>
                  ) : (
                    <Badge>À régler</Badge>
                  )}
                </td>
                <td className="text-right tabular-nums">{euro(r.totalIncl)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  Aucune facture.
                </td>
              </tr>
            ) : null}
          </tbody>
          {total ? (
            <tfoot>
              <tr className="border-t font-medium">
                <td colSpan={4}>Total à régler</td>
                <td className="text-right tabular-nums">{euro(centsToDecimal(total))}</td>
              </tr>
            </tfoot>
          ) : null}
        </Table>
      </Card>
    </div>
  );
}

export function NewInvoicePage() {
  return <InvoiceForm invoice={null} />;
}

export function InvoicePage() {
  const { id } = useParams({ from: '/app/appros/factures/$id' });
  const { data, error } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<InvoiceDetail>(`/supplier-invoices/${id}`),
  });
  if (error) return <QueryError error={error} />;
  if (!data) return <p className="text-muted-foreground">Chargement…</p>;
  return <InvoiceForm key={data.id + data.status + (data.documentMediaId ?? '')} invoice={data} />;
}

/** R-FAC-01/02/05: invoice with receipts, received difference, duplicates, document, payment. */
function InvoiceForm({ invoice }: { invoice: InvoiceDetail | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const suppliers = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.get<SupplierRow[]>('/suppliers'),
  });
  const [supplierId, setSupplierId] = useState(invoice?.supplierId ?? '');
  const supplier = useQuery({
    queryKey: ['supplier', supplierId],
    queryFn: () => api.get<SupplierDetail>(`/suppliers/${supplierId}`),
    enabled: !!supplierId,
  });
  const [pieceRef, setPieceRef] = useState(invoice?.pieceRef ?? '');
  const [date, setDate] = useState(invoice?.date ?? todayIso());
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? '');
  const [totalExcl, setTotalExcl] = useState(invoice?.totalExcl ?? '');
  const [totalVat, setTotalVat] = useState(invoice?.totalVat ?? '0');
  const [method, setMethod] = useState<SupplierPaymentMethod | ''>(invoice?.paymentMethod ?? '');
  const [comment, setComment] = useState(invoice?.comment ?? '');
  const [receiptIds, setReceiptIds] = useState<string[]>(invoice?.receipts.map((r) => r.id) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [paying, setPaying] = useState(false);
  const paid = invoice?.status === 'PAID';

  // Due date proposed from the supplier's payment terms (R-FAC-01).
  useEffect(() => {
    if (!invoice && supplier.data && date)
      setDueDate(invoiceDueDate(date, supplier.data.paymentTermsDays));
  }, [supplier.data, date, invoice]);

  const totalIncl = (() => {
    const a = parseAmountToCents(totalExcl || '0');
    const b = parseAmountToCents(totalVat || '0');
    return a !== null && b !== null ? centsToDecimal(a + b) : '';
  })();
  const check = useQuery({
    queryKey: ['invoice-check', supplierId, pieceRef, date, totalIncl, invoice?.id],
    queryFn: () =>
      api.post<{ duplicates: { id: string; pieceRef: string; date: string; totalIncl: string }[] }>(
        '/supplier-invoices/check',
        { id: invoice?.id, supplierId, pieceRef, date, totalIncl },
      ),
    enabled: !!supplierId && !!pieceRef && !!totalIncl,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        supplierId,
        pieceRef,
        date,
        dueDate: dueDate || undefined,
        totalExcl,
        totalVat: totalVat || '0',
        paymentMethod: method || null,
        comment,
        receiptIds,
      };
      return invoice
        ? api.put<{ id: string }>(`/supplier-invoices/${invoice.id}`, body)
        : api.post<{ id: string }>('/supplier-invoices', body);
    },
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      await queryClient.invalidateQueries({ queryKey: ['invoice', r.id] });
      if (!invoice) void navigate({ to: '/appros/factures/$id', params: { id: r.id } });
    },
    onError: (e) => setErrors(e instanceof ApiError ? e.fieldErrors() : {}),
  });
  const upload = useMutation({
    mutationFn: (file: File) => api.upload(`/supplier-invoices/${invoice!.id}/document`, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoice', invoice!.id] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <form onSubmit={submit} className="grid content-start gap-4">
        <h2 className="text-xl font-semibold">
          {invoice ? `Facture ${invoice.pieceRef}` : 'Nouvelle facture fournisseur'}
        </h2>
        {check.data?.duplicates.length ? (
          <Alert>
            Doublon probable (R-FAC-05) :{' '}
            {check.data.duplicates
              .map((d) => `pièce ${d.pieceRef} du ${formatDate(d.date)} (${euro(d.totalIncl)})`)
              .join(', ')}
            .
          </Alert>
        ) : null}
        <Card>
          <CardContent className="grid gap-4 pt-5">
            <Field label="Fournisseur" error={errors.supplierId}>
              {(p) => (
                <Select
                  {...p}
                  disabled={!!invoice}
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">Choisir…</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="N° de pièce" error={errors.pieceRef}>
                {(p) => (
                  <Input
                    {...p}
                    disabled={paid}
                    value={pieceRef}
                    onChange={(e) => setPieceRef(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Date" error={errors.date}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    disabled={paid}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Échéance" error={errors.dueDate}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    disabled={paid}
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Total HT (€)" error={errors.totalExcl}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    disabled={paid}
                    value={totalExcl}
                    onChange={(e) => setTotalExcl(e.target.value)}
                  />
                )}
              </Field>
              <Field label="TVA (€)" error={errors.totalVat} hint="Peut valoir 0.">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    disabled={paid}
                    value={totalVat}
                    onChange={(e) => setTotalVat(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Total TTC">
                {(p) => <Input {...p} disabled value={totalIncl ? euro(totalIncl) : ''} />}
              </Field>
            </div>
            <Field label="Mode de paiement prévu">
              {(p) => (
                <Select
                  {...p}
                  disabled={paid}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod | '')}
                >
                  <option value="">—</option>
                  {SUPPLIER_PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {SUPPLIER_PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {supplier.data?.receipts.length ? (
              <fieldset className="grid gap-1">
                <legend className="mb-1 text-sm font-medium">
                  Réceptions concernées (R-FAC-02)
                </legend>
                {supplier.data.receipts.slice(0, 20).map((r) => (
                  <div key={r.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`r-${r.id}`}
                      disabled={paid}
                      checked={receiptIds.includes(r.id)}
                      onChange={(e) =>
                        setReceiptIds(
                          e.target.checked
                            ? [...receiptIds, r.id]
                            : receiptIds.filter((x) => x !== r.id),
                        )
                      }
                    />
                    <Label htmlFor={`r-${r.id}`} className="font-normal">
                      {r.number} du {formatDate(r.date)}
                    </Label>
                  </div>
                ))}
              </fieldset>
            ) : null}
            <Field label="Commentaire">
              {(p) => (
                <Textarea
                  {...p}
                  disabled={paid}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              )}
            </Field>
          </CardContent>
        </Card>
        {save.error && !Object.keys(errors).length ? <Alert>{save.error.message}</Alert> : null}
        {save.isSuccess && invoice ? <Alert variant="success">Facture enregistrée.</Alert> : null}
        {!paid ? (
          <div className="flex gap-3">
            <Button type="submit" disabled={save.isPending || !supplierId}>
              {invoice ? 'Enregistrer' : 'Créer la facture'}
            </Button>
          </div>
        ) : null}
      </form>

      {invoice ? (
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">État</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {paid ? (
                <p>
                  <Badge variant="success">Réglée</Badge> le {formatDate(invoice.paidAt)}
                  {invoice.paymentMethod
                    ? ` par ${SUPPLIER_PAYMENT_METHOD_LABELS[invoice.paymentMethod].toLowerCase()}`
                    : ''}
                </p>
              ) : (
                <Button onClick={() => setPaying(true)}>Enregistrer le règlement</Button>
              )}
              {invoice.difference !== null ? (
                <p className={invoice.difference === '0.00' ? 'text-success' : 'text-destructive'}>
                  Reçu : {euro(invoice.receivedTotal)} · écart facturé − reçu :{' '}
                  {euro(invoice.difference)}
                </p>
              ) : null}
              <InvoiceEntries invoiceId={invoice.id} paid={paid} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Document</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {invoice.documentMediaId ? (
                <a
                  href={`/api/v1/media/${invoice.documentMediaId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-primary hover:underline"
                >
                  Ouvrir la facture
                </a>
              ) : (
                <p className="text-sm text-muted-foreground">Aucun document.</p>
              )}
              <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-input px-4 text-sm font-medium hover:bg-accent">
                <FileUp className="size-4" /> Joindre un PDF ou une photo
                <input
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
                />
              </label>
              {upload.error ? <Alert>{upload.error.message}</Alert> : null}
            </CardContent>
          </Card>
          <PayDialog invoice={invoice} open={paying} onClose={() => setPaying(false)} />
        </div>
      ) : null}
    </div>
  );
}

function PayDialog({
  invoice,
  open,
  onClose,
}: {
  invoice: InvoiceDetail;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState<SupplierPaymentMethod>(invoice.paymentMethod ?? 'TRANSFER');
  const pay = useMutation({
    mutationFn: () => api.post(`/supplier-invoices/${invoice.id}/pay`, { date, method }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Règlement de ${invoice.pieceRef}`}
      description={`Montant : ${euro(invoice.totalIncl)}`}
    >
      <div className="grid gap-3">
        <Field label="Date">
          {(p) => (
            <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          )}
        </Field>
        <Field label="Mode">
          {(p) => (
            <Select
              {...p}
              value={method}
              onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod)}
            >
              {SUPPLIER_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {SUPPLIER_PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {pay.error ? <Alert>{pay.error.message}</Alert> : null}
        <Button onClick={() => pay.mutate()} disabled={pay.isPending}>
          Marquer comme réglée
        </Button>
      </div>
    </Dialog>
  );
}

type SourceEntry = {
  id: string;
  label: string;
  status: 'DRAFT' | 'VALIDATED';
  displayNumber: string | null;
  sourceType: string | null;
};

/** R-CPT-08: accounting entries generated by the invoice and by its payment. */
function InvoiceEntries({ invoiceId, paid }: { invoiceId: string; paid: boolean }) {
  const { data } = useQuery({
    queryKey: ['entries', 'source', invoiceId, paid],
    queryFn: async () => {
      const [a, b] = await Promise.all([
        api.get<SourceEntry[]>(`/entries?sourceType=invoice&sourceId=${invoiceId}`),
        api.get<SourceEntry[]>(`/entries?sourceType=invoice_payment&sourceId=${invoiceId}`),
      ]);
      return [...a, ...b];
    },
    retry: false,
  });
  // Users without accounting access get no data: show nothing rather than an error.
  if (!data) return null;
  return (
    <div className="grid gap-1 border-t pt-2">
      <p className="font-medium">Écritures comptables</p>
      {data.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucune écriture pour le moment.</p>
      ) : (
        data.map((e) => (
          <Link
            key={e.id}
            to="/compta/ecritures/$id"
            params={{ id: e.id }}
            className="text-primary hover:underline"
          >
            {e.displayNumber ?? 'Brouillon'} · {e.label}
          </Link>
        ))
      )}
    </div>
  );
}
