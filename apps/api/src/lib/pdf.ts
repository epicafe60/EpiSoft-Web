import PDFDocument from 'pdfkit';
import { formatEuro, type Settings } from '@episoft/shared';

// PDF documents (spec §7.2: purchase orders, labels, reports). pdfkit's built-in
// Helvetica covers French accents and "€", but not the narrow no-break space that
// Intl uses in French numbers: text goes through pdfText().

export type Doc = PDFKit.PDFDocument;

export function pdfText(s: string): string {
  return s.replace(/[  ]/g, ' ');
}

export function eur(v: string | number): string {
  return pdfText(formatEuro(v));
}

export function render(
  build: (doc: Doc) => void | Promise<void>,
  options: PDFKit.PDFDocumentOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, ...options });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Promise.resolve(build(doc))
      .then(() => doc.end())
      .catch(reject);
  });
}

/** Association letterhead (R-CMD-03): name, address, SIREN, RNA, e-mail, phone. */
export function letterhead(doc: Doc, identity: Settings['association.identity']) {
  doc.font('Helvetica-Bold').fontSize(14).text(pdfText(identity.name));
  doc.font('Helvetica').fontSize(9);
  const address = [identity.street, [identity.postcode, identity.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  if (address) doc.text(pdfText(address));
  const ids = [
    identity.siren ? `SIREN ${identity.siren}` : null,
    identity.rna ? `RNA ${identity.rna}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (ids) doc.text(ids);
  const contact = [identity.email, identity.phone].filter(Boolean).join(' · ');
  if (contact) doc.text(pdfText(contact));
  doc.moveDown();
}

export interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

/** A simple table with a repeated header on each new page. */
export function table(
  doc: Doc,
  columns: Column[],
  rows: string[][],
  options: { fontSize?: number } = {},
) {
  const size = options.fontSize ?? 9;
  const left = doc.page.margins.left;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(size);
    let x = left;
    const y = doc.y;
    for (const c of columns) {
      doc.text(pdfText(c.header), x, y, { width: c.width - 4, align: c.align ?? 'left' });
      x += c.width;
    }
    doc
      .moveTo(left, doc.y + 2)
      .lineTo(left + columns.reduce((s, c) => s + c.width, 0), doc.y + 2)
      .strokeColor('#999')
      .stroke();
    doc.y += 5;
    doc.font('Helvetica').fontSize(size);
  };
  header();
  for (const row of rows) {
    const heights = row.map((cell, i) =>
      doc.heightOfString(pdfText(cell), { width: columns[i]!.width - 4 }),
    );
    const h = Math.max(...heights) + 3;
    if (doc.y + h > bottom()) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    let x = left;
    row.forEach((cell, i) => {
      doc.text(pdfText(cell), x, y, {
        width: columns[i]!.width - 4,
        align: columns[i]!.align ?? 'left',
      });
      x += columns[i]!.width;
    });
    doc.x = left;
    doc.y = y + h;
  }
  doc.x = left;
}

/** Label/value pairs, right-aligned values (totals, reports). */
export function keyValues(
  doc: Doc,
  pairs: [string, string][],
  options: { x?: number; width?: number; bold?: string[] } = {},
) {
  const x = options.x ?? doc.page.margins.left;
  const width = options.width ?? 250;
  for (const [k, v] of pairs) {
    const y = doc.y;
    const bold = options.bold?.includes(k);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    doc.text(pdfText(k), x, y, { width: width * 0.6 });
    doc.text(pdfText(v), x + width * 0.6, y, { width: width * 0.4, align: 'right' });
  }
  doc.font('Helvetica');
  doc.x = doc.page.margins.left;
}
