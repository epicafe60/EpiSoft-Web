import {
  centsToDecimal,
  decimalToCents,
  formatEuro,
  lineTotalCents,
  formatQty,
  parseQtyToMilli,
  formatVatRate,
  ticketVat,
  PAYMENT_METHOD_LABELS,
  type VatRegime,
  type SyncOp,
} from '@episoft/shared';
import { formatDateTime } from '@/lib/utils';

type SalePayload = Extract<SyncOp, { kind: 'SALE' }>['payload'];

/** What the ticket prints: a ticket of the queue, or one read from the server. */
export type ReceiptSale = Pick<SalePayload, 'provisionalNumber' | 'soldAt' | 'total'> & {
  lines: Pick<
    SalePayload['lines'][number],
    'productId' | 'label' | 'qty' | 'unitPrice' | 'discount'
  >[];
  payments: Pick<
    SalePayload['payments'][number],
    'method' | 'amount' | 'tendered' | 'change' | 'changeToWallet'
  >[];
};

/**
 * R-VTE-13 (optional, Q3): ticket for an 80 mm thermal printer, printed with the
 * browser's print dialog. Hidden on screen; only it is printed.
 */
export function Receipt({
  sale,
  associationName,
  memberName,
  duplicata,
  address = null,
  siren = null,
  regime = 'LIABLE',
  vatOf,
}: {
  sale: ReceiptSale | null;
  associationName: string;
  memberName: string | null;
  /** ADR 0016 §4: a reprint says so, with the rank of the copy. */
  duplicata?: number;
  /** R-TVA-05: printed under the name, from the local snapshot (works offline). */
  address?: string | null;
  siren?: string | null;
  regime?: VatRegime;
  /** VAT rate of a product of the local catalogue, and whether it is out of the scope of VAT. */
  vatOf?: (productId: string) => { rate: string; outOfScope: boolean } | undefined;
}) {
  if (!sale) return null;
  const vat = ticketVat(
    sale.lines.map((l) => {
      const v = vatOf?.(l.productId);
      return {
        rate: v?.rate ?? '0.00',
        outOfScope: v?.outOfScope ?? false,
        inclCents: lineTotalCents({
          qtyMilli: parseQtyToMilli(l.qty) ?? 0,
          unitPriceCents: decimalToCents(l.unitPrice),
          discountCents: decimalToCents(l.discount),
        }),
      };
    }),
    regime,
  );
  const change = sale.payments.reduce(
    (s, p) => s + (p.change && !p.changeToWallet ? Number(p.change) : 0),
    0,
  );
  return (
    <div className="print-area receipt hidden font-mono text-[11px] leading-tight text-black print:block">
      <p className="text-center text-sm font-bold">{associationName}</p>
      {duplicata ? (
        <p className="text-center text-sm font-bold">DUPLICATA (copie n° {duplicata})</p>
      ) : null}
      {address ? <p className="text-center">{address}</p> : null}
      {siren ? <p className="text-center">SIREN {siren}</p> : null}
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
      {vat.mention ? <p className="text-center">{vat.mention}</p> : null}
      {vat.rows.length > 0 ? (
        <div>
          <p className="flex justify-between">
            <span>TVA</span>
            <span>HT · TVA</span>
          </p>
          {vat.rows.map((r) => (
            <p key={r.rate} className="flex justify-between">
              <span>{formatVatRate(r.rate)}</span>
              <span>
                {formatEuro(centsToDecimal(r.exclCents))} · {formatEuro(centsToDecimal(r.vatCents))}
              </span>
            </p>
          ))}
        </div>
      ) : null}
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
