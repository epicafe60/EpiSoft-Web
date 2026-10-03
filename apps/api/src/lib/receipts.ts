import {
  centsToDecimal,
  formatEuro,
  formatQty,
  PAYMENT_METHOD_LABELS,
  parseQtyToMilli,
  type PaymentMethod,
} from '@episoft/shared';
import { formatParis } from './dates';
import { escapeHtml, type OutgoingEmail } from './mail';

const wrap = (title: string, body: string) =>
  `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#1c2b22">` +
  `<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h2>${body}` +
  `<p style="margin-top:24px;font-size:12px;color:#5b6b61">Épicafé de Montjavoult</p></div>`;

const td = 'padding:4px 6px;border-bottom:1px solid #e3e8e4';

export interface ReceiptSale {
  number: string;
  soldAt: Date;
  total: string;
  lines: { label: string; qty: string; unitPrice: string; lineTotal: string }[];
  payments: { method: PaymentMethod; amount: string }[];
  cashierName: string | null;
}

/** R-VTE-11 / R-VTE-16: the ticket by e-mail, sent only once the sale is recorded. */
export function saleReceiptEmail(to: string, firstName: string, s: ReceiptSale): OutgoingEmail {
  const rows = s.lines
    .map(
      (l) =>
        `<tr><td style="${td}">${escapeHtml(l.label)}</td>` +
        `<td style="${td};text-align:right">${formatQty(parseQtyToMilli(l.qty) ?? 0)}</td>` +
        `<td style="${td};text-align:right">${formatEuro(l.unitPrice)}</td>` +
        `<td style="${td};text-align:right">${formatEuro(l.lineTotal)}</td></tr>`,
    )
    .join('');
  const pays = s.payments
    .map((p) => `${PAYMENT_METHOD_LABELS[p.method]} : ${formatEuro(p.amount)}`)
    .join('<br>');
  const html = wrap(
    `Ticket ${s.number}`,
    `<p>Bonjour ${escapeHtml(firstName)},<br>voici votre ticket du ${formatParis(s.soldAt)}.</p>` +
      `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>` +
      `<th style="${td};text-align:left">Article</th><th style="${td};text-align:right">Qté</th>` +
      `<th style="${td};text-align:right">P.U.</th><th style="${td};text-align:right">Total</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<p style="font-size:16px"><strong>Total : ${formatEuro(s.total)}</strong></p><p>${pays}</p>`,
  );
  const text =
    `Ticket ${s.number} du ${formatParis(s.soldAt)}\n\n` +
    s.lines
      .map(
        (l) =>
          `${l.label}  ${formatQty(parseQtyToMilli(l.qty) ?? 0)} × ${formatEuro(l.unitPrice)} = ${formatEuro(l.lineTotal)}`,
      )
      .join('\n') +
    `\n\nTotal : ${formatEuro(s.total)}\n` +
    s.payments
      .map((p) => `${PAYMENT_METHOD_LABELS[p.method]} : ${formatEuro(p.amount)}`)
      .join('\n');
  return { to, subject: `Épicafé : ticket ${s.number}`, html, text };
}

/** R-CAG-06: top-up receipt with the old balance, the amount, the new balance and the mode. */
export function topupReceiptEmail(
  to: string,
  firstName: string,
  r: { at: Date; amountCents: number; beforeCents: number; method: PaymentMethod },
): OutgoingEmail {
  const after = r.beforeCents + r.amountCents;
  const lines = [
    `Ancien solde : ${formatEuro(centsToDecimal(r.beforeCents))}`,
    `Versement : ${formatEuro(centsToDecimal(r.amountCents))} (${PAYMENT_METHOD_LABELS[r.method]})`,
    `Nouveau solde : ${formatEuro(centsToDecimal(after))}`,
  ];
  return {
    to,
    subject: 'Épicafé : reçu de versement sur votre cagnotte',
    html: wrap(
      'Reçu de versement',
      `<p>Bonjour ${escapeHtml(firstName)},<br>nous avons bien reçu votre versement du ${formatParis(r.at)}.</p><p>${lines.join('<br>')}</p>`,
    ),
    text: `Bonjour ${firstName},\n\nVersement du ${formatParis(r.at)}\n${lines.join('\n')}`,
  };
}

export const euros = (cents: number) => formatEuro(centsToDecimal(cents));
