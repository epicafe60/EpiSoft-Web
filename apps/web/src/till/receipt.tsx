import {
  centsToDecimal,
  decimalToCents,
  formatEuro,
  lineTotalCents,
  formatQty,
  parseQtyToMilli,
  PAYMENT_METHOD_LABELS,
  type SyncOp,
} from '@episoft/shared';
import { formatDateTime } from '@/lib/utils';

type SalePayload = Extract<SyncOp, { kind: 'SALE' }>['payload'];

/**
 * R-VTE-13 (optional, Q3): ticket for an 80 mm thermal printer, printed with the
 * browser's print dialog. Hidden on screen; only it is printed.
 */
export function Receipt({
  sale,
  associationName,
  memberName,
}: {
  sale: SalePayload | null;
  associationName: string;
  memberName: string | null;
}) {
  if (!sale) return null;
  const change = sale.payments.reduce(
    (s, p) => s + (p.change && !p.changeToWallet ? Number(p.change) : 0),
    0,
  );
  return (
    <div className="print-area receipt hidden font-mono text-[11px] leading-tight text-black print:block">
      <p className="text-center text-sm font-bold">{associationName}</p>
      <p className="text-center">
        Ticket {sale.provisionalNumber} · {formatDateTime(sale.soldAt)}
      </p>
      {memberName ? <p className="text-center">{memberName}</p> : null}
      <hr className="my-1 border-dashed border-black" />
      {sale.lines.map((l, i) => (
        <div key={i}>
          <p>{l.label}</p>
          <p className="flex justify-between">
            <span>
              {formatQty(parseQtyToMilli(l.qty) ?? 0)} × {formatEuro(l.unitPrice)}
              {l.discount !== '0.00' ? ` − ${formatEuro(l.discount)}` : ''}
            </span>
            <span>
              {formatEuro(
                centsToDecimal(
                  lineTotalCents({
                    qtyMilli: parseQtyToMilli(l.qty) ?? 0,
                    unitPriceCents: decimalToCents(l.unitPrice),
                    discountCents: decimalToCents(l.discount),
                  }),
                ),
              )}
            </span>
          </p>
        </div>
      ))}
      <hr className="my-1 border-dashed border-black" />
      <p className="flex justify-between text-sm font-bold">
        <span>TOTAL</span>
        <span>{formatEuro(sale.total)}</span>
      </p>
      {sale.payments.map((p, i) => (
        <p key={i} className="flex justify-between">
          <span>{PAYMENT_METHOD_LABELS[p.method]}</span>
          <span>{formatEuro(p.tendered ?? p.amount)}</span>
        </p>
      ))}
      {change > 0 ? (
        <p className="flex justify-between">
          <span>Rendu</span>
          <span>{formatEuro(change)}</span>
        </p>
      ) : null}
      <p className="mt-2 text-center">Merci de votre visite !</p>
    </div>
  );
}
