import type { Settings } from '@episoft/shared';
import { pdfText, type Doc } from './pdf';

// The purchase order sent to a supplier, in the layout of the paper the association has always sent:
// the letterhead on the left and the logo on the right, the supplier below the logo, then a table
// (product, price with VAT, quantity, total) under a grey band, and the total of the order.

export interface OrderSheet {
  identity: Settings['association.identity'];
  number: string;
  /** dd/mm/yyyy */
  date: string;
  supplier: { name: string; lines: string[] } | null;
  /** Designation, unit price (VAT included), quantity, line total (VAT included). */
  rows: [string, string, string, string][];
  total: string;
  comment: string | null;
  /** The logo (PNG or JPEG), from the library of images; none, none is drawn. */
  logo: Buffer | null;
}

const PAGE_WIDTH = 595.28;
const LEFT = 40;
const RIGHT = PAGE_WIDTH - 40;
// The columns of the table: the designation takes what is left, then three narrow ones.
const NAME_WIDTH = 262;
const COLUMNS = [
  { x: 310, width: 90, header: 'P.A TTC' },
  { x: 400, width: 75, header: 'Quantité' },
  { x: 475, width: RIGHT - 475, header: 'Total' },
] as const;
const ROW_MIN_HEIGHT = 26;
const BAND_HEIGHT = 20;
const BOTTOM = 802;

/** The letterhead lines, a blank line between the groups (address, identifiers, contact, order). */
function letterheadGroups(s: OrderSheet): string[][] {
  const { identity } = s;
  const place = [identity.postcode, identity.city].filter(Boolean).join(' - ');
  return [
    [identity.street, place].filter((x): x is string => !!x),
    [
      identity.siren ? `SIREN : ${identity.siren}` : '',
      identity.rna ? `RNA : ${identity.rna}` : '',
    ].filter(Boolean),
    [
      identity.email ? `Email : ${identity.email}` : '',
      identity.phone ? `Tel : ${identity.phone}` : '',
    ].filter(Boolean),
    [`Commande ${s.number} du ${s.date}`],
  ].filter((g) => g.length);
}

function band(doc: Doc, y: number): number {
  doc.rect(0, y, PAGE_WIDTH, BAND_HEIGHT).fill('#e6e6e6');
  doc
    .moveTo(0, y + BAND_HEIGHT)
    .lineTo(PAGE_WIDTH, y + BAND_HEIGHT)
    .lineWidth(0.8)
    .strokeColor('#666666')
    .stroke();
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  doc.text('Désignation du produit', LEFT, y + 5, { width: NAME_WIDTH, align: 'center' });
  for (const c of COLUMNS) doc.text(c.header, c.x, y + 5, { width: c.width, align: 'center' });
  return y + BAND_HEIGHT + 2;
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

export function drawOrderSheet(doc: Doc, s: OrderSheet): void {
  const top = 40;
  doc.fillColor('#000000');

  // Letterhead, on the left.
  let y = top;
  const nameLines = /^association/i.test(s.identity.name)
    ? [s.identity.name]
    : ['Association', s.identity.name];
  doc.font('Helvetica-Bold').fontSize(11);
  for (const l of nameLines) {
    doc.text(pdfText(l), LEFT, y, { width: 240 });
    y = doc.y + 1;
  }
  y += 8;
  doc.font('Helvetica').fontSize(10);
  for (const group of letterheadGroups(s)) {
    for (const l of group) {
      doc.text(pdfText(l), LEFT, y, { width: 240 });
      y = doc.y + 1;
    }
    y += 9;
  }

  // The logo, on the right, and the supplier under it.
  const logoWidth = 175;
  let logoHeight = 95;
  if (s.logo) {
    try {
      const size = imageSize(s.logo);
      doc.image(s.logo, RIGHT - logoWidth, top - 4, { width: logoWidth });
      logoHeight = (logoWidth * size.height) / size.width;
    } catch {
      // An image the PDF cannot read: the order is made without it.
    }
  }
  let sy = top - 4 + logoHeight + 26;
  if (s.supplier) {
    doc.font('Helvetica').fontSize(10.5);
    doc.text(pdfText(s.supplier.name), 290, sy, { width: RIGHT - 290 });
    sy = doc.y + 10;
    for (const l of s.supplier.lines) {
      doc.text(pdfText(l), 294, sy, { width: RIGHT - 294 });
      sy = doc.y + 10;
    }
  }

  // The table.
  y = band(doc, Math.max(y, sy) + 8);
  doc.font('Helvetica').fontSize(10);
  for (const [name, unit, qty, total] of s.rows) {
    const text = doc.heightOfString(pdfText(name), { width: NAME_WIDTH - 8 });
    const h = Math.max(ROW_MIN_HEIGHT, text + 14);
    if (y + h > BOTTOM) {
      doc.addPage();
      y = band(doc, 40);
    }
    doc.fillColor('#000000').font('Helvetica').fontSize(10);
    doc.text(pdfText(name), LEFT + 4, y + 7, { width: NAME_WIDTH - 8 });
    [unit, qty, total].forEach((cell, i) => {
      const c = COLUMNS[i]!;
      doc.text(pdfText(cell), c.x, y + 7, { width: c.width - 8, align: 'right' });
    });
    doc
      .moveTo(LEFT, y + h)
      .lineTo(RIGHT, y + h)
      .lineWidth(0.5)
      .strokeColor('#cccccc')
      .stroke();
    y += h;
  }

  // The total of the order.
  if (y + 40 > BOTTOM) {
    doc.addPage();
    y = 40;
  }
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Total de la commande', 290, y + 8, { width: 183, align: 'right' });
  doc.text(pdfText(s.total), COLUMNS[2].x, y + 8, { width: COLUMNS[2].width - 8, align: 'right' });
  y += 30;

  if (s.comment) {
    doc.font('Helvetica').fontSize(10);
    if (y + 30 > BOTTOM) {
      doc.addPage();
      y = 40;
    }
    doc.text(pdfText(`Commentaire : ${s.comment}`), LEFT, y, { width: RIGHT - LEFT });
  }
  doc.x = LEFT;
}
