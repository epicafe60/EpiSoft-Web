import {
  fillLabel,
  fillZone,
  pdfTemplateDef,
  type PdfColumnDef,
  type PdfTemplateConfig,
  type Settings,
  type Values,
} from '@episoft/shared';
import type { Doc } from './pdf';
import { drawPdfHtml, heightOfPdfHtml } from './pdf-html';
import { associationValues, installFooter } from './pdf-template';

// The purchase order sent to a supplier, in the layout of the paper the association has always sent:
// the letterhead on the left and the logo on the right, the supplier below the logo, then a table
// under a grey band and the total of the order. What the text zones say and which columns the table
// has come from the template (packages/shared/src/pdf-templates.ts); where things go is here.

/** One line of the order, every amount already written (in euros, with a comma). */
export interface OrderSheetLine {
  ref: string;
  code: string;
  name: string;
  unitExcl: string;
  vat: string;
  unitIncl: string;
  qty: string;
  totalExcl: string;
  totalIncl: string;
}

export interface OrderSheet {
  identity: Settings['association.identity'];
  number: string;
  /** dd/mm/yyyy */
  date: string;
  supplier: {
    name: string;
    street: string;
    postcodeCity: string;
    phone: string;
    email: string;
  } | null;
  lines: OrderSheetLine[];
  totalExcl: string;
  totalVat: string;
  totalIncl: string;
  comment: string | null;
  /** The logo (PNG or JPEG), from the library of images; none, none is drawn. */
  logo: Buffer | null;
}

const def = pdfTemplateDef('purchase_order')!;

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = 40;
const RIGHT = PAGE_WIDTH - 40;
const CONTENT = RIGHT - LEFT;
const MIN_NAME_WIDTH = 110;
const ROW_MIN_HEIGHT = 26;
const BAND_HEIGHT = 20;

/** The cell of a column for a line. */
const CELL: Record<string, (l: OrderSheetLine) => string> = {
  ref: (l) => l.ref,
  code: (l) => l.code,
  name: (l) => l.name,
  unit_excl: (l) => l.unitExcl,
  vat: (l) => l.vat,
  unit_incl: (l) => l.unitIncl,
  qty: (l) => l.qty,
  total_excl: (l) => l.totalExcl,
  total_incl: (l) => l.totalIncl,
};

export interface PreparedColumn {
  key: string;
  header: string;
  align: 'left' | 'right';
  width: number;
}

/** What is drawn, as text: the zones filled in, the columns with their widths, the cells. */
export interface PreparedSheet {
  header: string;
  supplier: string;
  afterTable: string;
  footer: string;
  columns: PreparedColumn[];
  rows: string[][];
  /** Label of the total and the totals under their columns (key of the column → text). */
  totalLabel: string;
  totals: Record<string, string>;
  logo: Buffer | null;
}

export function orderValues(s: OrderSheet): Values {
  return {
    ...associationValues(s.identity),
    numero: s.number,
    date: s.date,
    fournisseur_nom: s.supplier?.name ?? '',
    fournisseur_rue: s.supplier?.street ?? '',
    fournisseur_code_postal_ville: s.supplier?.postcodeCity ?? '',
    fournisseur_telephone: s.supplier?.phone ?? '',
    fournisseur_email: s.supplier?.email ?? '',
    total_ht: s.totalExcl,
    total_tva: s.totalVat,
    total: s.totalIncl,
    nombre_lignes: String(s.lines.length),
    commentaire: s.comment ?? '',
  };
}

/**
 * The widths of the columns: the ones with a width keep it (scaled down when too many are shown),
 * the designation takes what is left.
 */
export function columnWidths(chosen: { def: PdfColumnDef }[]): number[] {
  const fixed = chosen.reduce((s, c) => s + (c.def.width ?? 0), 0);
  const scale = Math.min(1, (CONTENT - MIN_NAME_WIDTH) / (fixed || 1));
  const widths = chosen.map((c) => (c.def.width ? c.def.width * scale : 0));
  const rest = CONTENT - widths.reduce((s, w) => s + w, 0);
  return widths.map((w) => (w === 0 ? rest : w));
}

export function prepareOrderSheet(s: OrderSheet, config: PdfTemplateConfig): PreparedSheet {
  const values = orderValues(s);
  const zone = (key: string) => fillZone(config.zones[key] ?? '', values, def.variables);
  const chosen = config.columns.map((c) => ({
    def: def.columns.find((d) => d.key === c.key)!,
    header: c.label,
  }));
  const widths = columnWidths(chosen);
  return {
    header: zone('header'),
    supplier: zone('supplier'),
    afterTable: zone('after_table'),
    footer: zone('footer'),
    columns: chosen.map((c, i) => ({
      key: c.def.key,
      header: c.header,
      align: c.def.align,
      width: widths[i]!,
    })),
    rows: s.lines.map((l) => chosen.map((c) => CELL[c.def.key]!(l))),
    totalLabel: fillLabel(config.labels.total ?? '', values, def.variables),
    totals: { total_excl: s.totalExcl, total_incl: s.totalIncl },
    logo: config.logo ? s.logo : null,
  };
}

/** Width and height of a PNG or a JPEG, read in its header; throws on anything else. */
export function imageSize(b: Buffer): { width: number; height: number } {
  if (b.length > 24 && b.subarray(1, 4).toString() === 'PNG')
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      // Start of frame (not the tables 0xc4, 0xc8, 0xcc): height, then width.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  throw new Error('image illisible');
}

function band(doc: Doc, y: number, columns: PreparedColumn[]): number {
  // A long header wraps: the band is as tall as its tallest header.
  doc.font('Helvetica').fontSize(10);
  const text = Math.max(
    ...columns.map((c) => doc.heightOfString(c.header, { width: c.width - 4, align: 'center' })),
  );
  const height = Math.max(BAND_HEIGHT, text + 10);
  doc.rect(0, y, PAGE_WIDTH, height).fill('#e6e6e6');
  doc
    .moveTo(0, y + height)
    .lineTo(PAGE_WIDTH, y + height)
    .lineWidth(0.8)
    .strokeColor('#666666')
    .stroke();
  doc.fillColor('#000000');
  let x = LEFT;
  for (const c of columns) {
    doc.text(c.header, x + 2, y + 5, { width: c.width - 4, align: 'center' });
    x += c.width;
  }
  return y + height + 2;
}

export function drawOrderSheet(doc: Doc, p: PreparedSheet): void {
  const top = 40;
  doc.fillColor('#000000');
  const footerHeight = installFooter(doc, p.footer, LEFT, CONTENT);
  const bottom = Math.min(802, PAGE_HEIGHT - footerHeight - 6);

  // The header zone, on the left; the logo, on the right, and the supplier zone under it.
  let y = drawPdfHtml(doc, p.header, LEFT, top, 240);
  let logoBottom = top;
  if (p.logo) {
    const logoWidth = 175;
    try {
      const size = imageSize(p.logo);
      doc.image(p.logo, RIGHT - logoWidth, top - 4, { width: logoWidth });
      logoBottom = top - 4 + (logoWidth * size.height) / size.width + 26;
    } catch {
      // An image the PDF cannot read: the order is made without it.
    }
  }
  const sy = drawPdfHtml(doc, p.supplier, 290, logoBottom, RIGHT - 290);

  // The table.
  y = band(doc, Math.max(y, sy) + 8, p.columns);
  doc.font('Helvetica').fontSize(10);
  for (const row of p.rows) {
    let height = ROW_MIN_HEIGHT;
    row.forEach((cell, i) => {
      height = Math.max(height, doc.heightOfString(cell, { width: p.columns[i]!.width - 8 }) + 14);
    });
    if (y + height > bottom) {
      doc.addPage();
      y = band(doc, 40, p.columns);
    }
    doc.fillColor('#000000').font('Helvetica').fontSize(10);
    let x = LEFT;
    row.forEach((cell, i) => {
      const c = p.columns[i]!;
      doc.text(cell, x + 4, y + 7, { width: c.width - 8, align: c.align });
      x += c.width;
    });
    doc
      .moveTo(LEFT, y + height)
      .lineTo(RIGHT, y + height)
      .lineWidth(0.5)
      .strokeColor('#cccccc')
      .stroke();
    y += height;
  }

  // The total of the order: under its columns, its label before the first of them.
  const totalColumns = p.columns.filter((c) => c.key in p.totals);
  if (totalColumns.length) {
    if (y + 30 > bottom) {
      doc.addPage();
      y = 40;
    }
    doc.font('Helvetica-Bold').fontSize(10);
    let x = LEFT;
    for (const c of p.columns) {
      if (c.key === totalColumns[0]!.key)
        doc.text(p.totalLabel, LEFT, y + 8, {
          width: x - LEFT - 8,
          align: 'right',
          lineBreak: false,
        });
      if (c.key in p.totals)
        doc.text(p.totals[c.key]!, x + 4, y + 8, { width: c.width - 8, align: 'right' });
      x += c.width;
    }
    y += 30;
  }

  // What comes under the table.
  if (p.afterTable.trim()) {
    const h = heightOfPdfHtml(doc, p.afterTable, CONTENT);
    if (y + h > bottom) {
      doc.addPage();
      y = 40;
    }
    drawPdfHtml(doc, p.afterTable, LEFT, y + 4, CONTENT);
  }
  doc.x = LEFT;
}
