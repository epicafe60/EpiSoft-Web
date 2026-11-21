import { useState } from 'react';
import { CornerDownLeft, Printer } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  centsToDecimal,
  decimalToCents,
  formatEuro,
  lineTotalCents,
  parseQtyToMilli,
  PAYMENT_METHOD_LABELS,
  regimeAt,
  returnLineRefund,
  shopFormat,
  type PaymentMethod,
} from '@episoft/shared';
import { Button } from '@/components/ui/button';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { confirmNow } from '@/components/confirm';
import { DEFAULT_BRANDING_INFO } from '@/lib/branding';
import { tillDb } from './db';
import { useTill } from './context';
import { enqueue, enqueueSealed } from './sync';
import { Receipt, type ReceiptSale } from './receipt';

interface TicketLine {
  lineNo: number;
  label: string;
  qty: string;
  unitPrice: string;
  discount: string;
}

/**
 * ADR 0016 §4 and §5: what a ticket allows besides cancelling it. A copy is printed as
 * « DUPLICATA » and counted (the till can do it offline: the operation waits in the queue). A
 * credit note gives back chosen quantities of chosen lines, with a reason and a refund method;
 * the server computes the amounts again and refuses more than was sold.
 */
export function TicketActions({
  saleId,
  number,
  sale,
  lines,
  paidWith,
  hasMember,
  cancelled,
  memberName,
  onDone,
}: {
  saleId: string;
  number: string;
  sale: ReceiptSale;
  lines: TicketLine[];
  paidWith: PaymentMethod[];
  hasMember: boolean;
  cancelled: boolean;
  memberName: string | null;
  onDone: () => void;
}) {
  const { meta, cashierId, cashierCheck, cashierProof, engine, settings } = useTill();
  const products = useLiveQuery(() => tillDb.products.toArray(), []);
  const reprints = useLiveQuery(
    () =>
      tillDb.outbox
        .filter((e) => e.op.kind === 'TICKET_REPRINT' && e.op.payload.saleId === saleId)
        .count(),
    [saleId],
    0,
  );
  const [copy, setCopy] = useState<number | null>(null);
  const [returning, setReturning] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(paidWith[0] ?? 'CASH');
  const [restock, setRestock] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionId = meta.session?.id;

  const methods = [
    ...new Set<PaymentMethod>([...paidWith, ...(hasMember ? ['WALLET' as const] : [])]),
  ];

  const reprint = async () => {
    if (!sessionId) return;
    const rank = reprints + 1;
    await enqueue((deviceSeq) => ({
      kind: 'TICKET_REPRINT',
      id: crypto.randomUUID(),
      deviceSeq,
      payload: {
        saleId,
        sessionId,
        cashierId,
        cashierCheck,
        ...(cashierProof ? { cashierProof } : {}),
        at: new Date().toISOString(),
      },
    }));
    engine.kick();
    setCopy(rank);
    // The copy is in the page (hidden on screen) once React has drawn it.
    setTimeout(() => window.print(), 50);
  };

  const wanted = lines.flatMap((l) => {
    const q = parseQtyToMilli(qty[l.lineNo] ?? '');
    return q && q > 0 ? [{ line: l, qtyMilli: q }] : [];
  });
  // What the till can say before the server checks the quantities already given back.
  const preview = wanted.reduce((sum, w) => {
    const total = lineTotalCents({
      qtyMilli: parseQtyToMilli(w.line.qty) ?? 0,
      unitPriceCents: decimalToCents(w.line.unitPrice),
      discountCents: decimalToCents(w.line.discount),
    });
    const r = returnLineRefund({
      lineTotalCents: total,
      qtyMilli: parseQtyToMilli(w.line.qty) ?? 0,
      returnedQtyMilli: 0,
      returnedCents: 0,
      returnQtyMilli: w.qtyMilli,
    });
    return sum + ('cents' in r ? r.cents : 0);
  }, 0);

  const submit = async () => {
    setError(null);
    if (!sessionId || !meta.device) return;
    if (!wanted.length) return setError('Indiquez la quantité rendue d’au moins une ligne.');
    for (const w of wanted) {
      const sold = parseQtyToMilli(w.line.qty) ?? 0;
      if (w.qtyMilli > sold)
        return setError(`Ligne « ${w.line.label} » : pas plus que ce qui a été vendu.`);
    }
    if (reason.trim().length < 3) return setError('Indiquez le motif du retour.');
    if (
      !(await confirmNow({
        title: 'Établir un avoir ?',
        message: `Rembourser environ ${formatEuro(centsToDecimal(preview))} (${PAYMENT_METHOD_LABELS[method]}) sur le ticket ${number}. Un avoir ne s’efface pas.`,
        confirmLabel: 'Établir l’avoir',
        cancelLabel: 'Revenir',
      }))
    )
      return;
    await enqueueSealed(meta.device.name, ({ deviceSeq, number: no }) => ({
      kind: 'SALE_RETURN' as const,
      id: crypto.randomUUID(),
      deviceSeq,
      payload: {
        returnSaleId: crypto.randomUUID(),
        saleId,
        sessionId,
        cashierId,
        cashierCheck,
        ...(cashierProof ? { cashierProof } : {}),
        at: new Date().toISOString(),
        provisionalNumber: no,
        reason: reason.trim(),
        refundMethod: method,
        restock,
        lines: wanted.map((w) => ({
          lineNo: w.line.lineNo,
          qty: (w.qtyMilli / 1000).toString(),
        })),
      },
    }));
    engine.kick();
    onDone();
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void reprint()} disabled={!sessionId}>
          <Printer /> Imprimer un duplicata
        </Button>
        {!cancelled && sessionId ? (
          <Button variant="outline" onClick={() => setReturning((v) => !v)}>
            <CornerDownLeft /> Établir un avoir (retour partiel)
          </Button>
        ) : null}
      </div>
      {returning ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-muted-foreground">
            Quantité rendue par ligne. Le serveur recalcule le montant et refuse plus que ce qui a
            été vendu, avoirs précédents compris.
          </p>
          {lines.map((l) => (
            <label key={l.lineNo} className="grid grid-cols-[1fr_6rem] items-center gap-2">
              <span>
                {l.label}{' '}
                <span className="text-muted-foreground">
                  (vendu {l.qty} × {formatEuro(l.unitPrice)})
                </span>
              </span>
              <Input
                inputMode="decimal"
                aria-label={`Quantité rendue : ${l.label}`}
                value={qty[l.lineNo] ?? ''}
                onChange={(e) => setQty({ ...qty, [l.lineNo]: e.target.value.replace(',', '.') })}
              />
            </label>
          ))}
          <Field label="Motif du retour">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Field label="Remboursement par">
            {(p) => (
              <Select
                {...p}
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              >
                {methods.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                    {m === 'WALLET' ? ' (cagnotte)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2">
            <Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} />
            Remettre en stock (sinon la marchandise est comptée en perte)
          </label>
          {error ? <Alert>{error}</Alert> : null}
          <Button onClick={() => void submit()}>
            Établir l’avoir{preview ? ` de ${formatEuro(centsToDecimal(preview))}` : ''}
          </Button>
        </div>
      ) : null}
      {copy ? (
        <Receipt
          sale={sale}
          associationName={settings?.associationName ?? DEFAULT_BRANDING_INFO.associationName}
          memberName={memberName}
          duplicata={copy}
          // A duplicata reproduces the ticket: same address, SIREN, VAT regime of the day and VAT by rate.
          address={settings?.associationAddress ?? null}
          siren={settings?.associationSiren ?? null}
          regime={regimeAt(
            settings?.vatRegimes ?? [],
            shopFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
              new Date(sale.soldAt),
            ),
          )}
          vatOf={(id) => {
            const p = products?.find((x) => x.id === id);
            return p ? { rate: p.vatRate, outOfScope: p.code === '01004' } : undefined;
          }}
        />
      ) : null}
    </div>
  );
}
