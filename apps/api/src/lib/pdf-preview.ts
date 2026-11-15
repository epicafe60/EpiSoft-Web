import {
  fillZone,
  pdfSampleValues,
  pdfTemplateDef,
  type PdfDocKey,
  type PdfTemplateConfig,
} from '@episoft/shared';
import { drawOrderSheet, prepareOrderSheet, type OrderSheet } from './order-sheet';
import { eur, keyValues, render, table } from './pdf';
import { drawPdfHtml } from './pdf-html';
import { associationValues, installFooter } from './pdf-template';
import { loadSettings } from '../modules/admin/settings-store';
import type { DbOrTx } from '@episoft/db';

// What a PDF looks like with the template being edited, filled with samples: a purchase order of nine
// lines, a closing, a report. The layout is the one of the real document (same drawing code).

const SAMPLE_LINES = [
  ["Savon l'exfoliant 100g", 'SV-100', '5', '5,60'],
  ['Savon le Détox', 'SV-101', '5', '5,60'],
  ["L'Original Adam", 'OR-102', '3', '5,20'],
  ["L'Original Eve", 'OR-103', '8', '5,20'],
  ['Le Parnature', 'PA-104', '5', '4,80'],
  ['La Mascotte', 'MA-105', '3', '3,60'],
  ['Le Macaron', 'MC-106', '3', '2,40'],
  ['La Tortue', 'TO-107', '3', '1,60'],
  ['Fée le ménage', 'FM-108', '2', '6,00'],
] as const;

const money = (n: number) => n.toFixed(2).replace('.', ',');

/** An order of nine lines, with the supplier and the amounts of the sample values. */
export function sampleOrderSheet(
  identity: OrderSheet['identity'],
  logo: Buffer | null,
): OrderSheet {
  const def = pdfTemplateDef('purchase_order')!;
  const v = pdfSampleValues(def);
  const lines = SAMPLE_LINES.map(([name, ref, qty, pu], i) => {
    const incl = Number(pu.replace(',', '.')) * Number(qty);
    return {
      ref,
      code: `0100${i + 1}`,
      name,
      unitExcl: money(Number(pu.replace(',', '.')) / 1.2),
      vat: '20 %',
      unitIncl: pu,
      qty,
      totalExcl: money(incl / 1.2),
      totalIncl: money(incl),
    };
  });
  return {
    identity,
    number: v.numero!,
    date: v.date!,
    supplier: {
      name: v.fournisseur_nom!,
      street: v.fournisseur_rue!,
      postcodeCity: v.fournisseur_code_postal_ville!,
      phone: v.fournisseur_telephone!,
      email: v.fournisseur_email!,
    },
    lines,
    totalExcl: v.total_ht!,
    totalVat: v.total_tva!,
    totalIncl: v.total!,
    comment: v.commentaire!,
    logo,
  };
}

export async function previewPdf(
  db: DbOrTx,
  key: PdfDocKey,
  config: PdfTemplateConfig,
  logo: Buffer | null,
): Promise<Buffer> {
  const def = pdfTemplateDef(key)!;
  const identity = (await loadSettings(db))['association.identity'];
  if (key === 'purchase_order')
    return render((doc) =>
      drawOrderSheet(doc, prepareOrderSheet(sampleOrderSheet(identity, logo), config)),
    );

  // The association is the real one, the rest is a sample.
  const values = { ...pdfSampleValues(def), ...associationValues(identity) };
  return render((doc) => {
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    installFooter(doc, fillZone(config.zones.footer ?? '', values, def.variables), left, width);
    doc.y = drawPdfHtml(
      doc,
      fillZone(config.zones.header ?? '', values, def.variables),
      left,
      doc.page.margins.top,
      width,
    );
    doc.x = left;
    doc.moveDown();
    if (key === 'cash_closing') {
      keyValues(
        doc,
        [
          ['Tickets', '42 (annulations : 1)'],
          ['Total des ventes', eur('812.40')],
          ['Espèces', eur('310.00')],
          ['Carte bancaire', eur('420.40')],
          ['Cagnotte', eur('82.00')],
          ['Fond initial', eur('150.00')],
        ],
        { width: 330 },
      );
    } else {
      table(
        doc,
        [
          { header: 'Date', width: 90 },
          { header: 'Libellé', width: 270 },
          { header: 'Débit', width: 80, align: 'right' },
          { header: 'Crédit', width: 80, align: 'right' },
        ],
        [
          ['02/01/2026', 'Ventes de la journée', '', eur('812.40')],
          ['03/01/2026', 'Achat de marchandises', eur('143.33'), ''],
          ['05/01/2026', 'Cotisations', '', eur('96.00')],
        ],
        { fontSize: 9 },
      );
    }
  });
}
