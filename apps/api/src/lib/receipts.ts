import type { DbOrTx } from '@episoft/db';
import {
  centsToDecimal,
  formatEuro,
  formatQty,
  PAYMENT_METHOD_LABELS,
  parseQtyToMilli,
  type PaymentMethod,
  type Values,
} from '@episoft/shared';
import { formatShop } from './dates';
import { queueTemplatedEmail } from './email-render';
import { escapeHtml } from './mail';

// The values that fill the receipts (ticket, top-up). The wording around them is a template that
// the administrators can edit (packages/shared/src/email-templates.ts).

const td = 'padding:4px 6px;border-bottom:1px solid #e3e8e4';

export interface ReceiptSale {
  number: string;
  soldAt: Date;
  total: string;
  lines: { label: string; qty: string; unitPrice: string; lineTotal: string }[];
  payments: { method: PaymentMethod; amount: string }[];
  cashierName: string | null;
  /** R-EVO-40: cagnotte before and after the ticket, when the member has a household. */
  balance?: { beforeCents: number; afterCents: number };
}

export const euros = (cents: number) => formatEuro(centsToDecimal(cents));

/** R-VTE-11 / R-VTE-16: what fills the ticket e-mail. */
export function saleReceiptValues(firstName: string, s: ReceiptSale): Values {
  const rows = s.lines
    .map(
      (l) =>
        `<tr><td style="${td}">${escapeHtml(l.label)}</td>` +
        `<td style="${td};text-align:right">${formatQty(parseQtyToMilli(l.qty) ?? 0)}</td>` +
        `<td style="${td};text-align:right">${formatEuro(l.unitPrice)}</td>` +
        `<td style="${td};text-align:right">${formatEuro(l.lineTotal)}</td></tr>`,
    )
    .join('');
  const table =
    `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>` +
    `<th style="${td};text-align:left">Article</th><th style="${td};text-align:right">Qté</th>` +
    `<th style="${td};text-align:right">P.U.</th><th style="${td};text-align:right">Total</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
  return {
    prenom: firstName,
    numero: s.number,
    date: formatShop(s.soldAt),
    total: formatEuro(s.total),
    lignes: table,
    paiements: s.payments
      .map((p) => `${PAYMENT_METHOD_LABELS[p.method]} : ${formatEuro(p.amount)}`)
      .join('<br>'),
    cagnotte_avant: s.balance
      ? `<p>Solde de votre cagnotte avant : ${euros(s.balance.beforeCents)}</p>`
      : '',
    cagnotte_apres: s.balance
      ? `<p><strong>Solde de votre cagnotte après : ${euros(s.balance.afterCents)}</strong></p>`
      : '',
  };
}

export const queueSaleReceipt = (tx: DbOrTx, to: string, firstName: string, s: ReceiptSale) =>
  queueTemplatedEmail(tx, 'sale_receipt', to, saleReceiptValues(firstName, s));

/** R-CAG-06: top-up receipt with the old balance, the amount, the new balance and the mode. */
export function topupReceiptValues(
  firstName: string,
  r: { at: Date; amountCents: number; beforeCents: number; method: PaymentMethod },
): Values {
  return {
    prenom: firstName,
    date: formatShop(r.at),
    ancien_solde: euros(r.beforeCents),
    montant: euros(r.amountCents),
    mode: PAYMENT_METHOD_LABELS[r.method],
    nouveau_solde: euros(r.beforeCents + r.amountCents),
  };
}

export const queueTopupReceipt = (
  tx: DbOrTx,
  to: string,
  firstName: string,
  r: { at: Date; amountCents: number; beforeCents: number; method: PaymentMethod },
) => queueTemplatedEmail(tx, 'topup_receipt', to, topupReceiptValues(firstName, r));
