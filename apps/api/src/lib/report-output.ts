import ExcelJS from 'exceljs';
import type { Settings } from '@episoft/shared';
import { eur, letterhead, pdfText, render, table, type Column } from './pdf';

// A report is a plain table: the same structure feeds the screen, the Excel export and the PDF.

export interface ReportColumn {
  key: string;
  label: string;
  /** Money columns hold decimal strings ("12.30") and are right-aligned. */
  type: 'text' | 'money';
  /** Relative width. */
  width?: number;
}

export interface ReportLine {
  cells: Record<string, string | null>;
  bold?: boolean;
}

export interface ReportTable {
  title: string;
  subtitle?: string;
  columns: ReportColumn[];
  rows: ReportLine[];
}

export async function reportXlsx(r: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(r.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.columns = r.columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.round((c.width ?? 1) * 14) + 4,
    style: c.type === 'money' ? { numFmt: '#,##0.00 €' } : {},
  }));
  ws.getRow(1).font = { bold: true };
  for (const line of r.rows) {
    const row = ws.addRow(
      Object.fromEntries(
        r.columns.map((c) => {
          const v = line.cells[c.key] ?? null;
          return [c.key, c.type === 'money' && v !== null && v !== '' ? Number(v) : v];
        }),
      ),
    );
    if (line.bold) row.font = { bold: true };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function reportPdf(r: ReportTable, identity: Settings['association.identity']) {
  return render(
    (doc) => {
      letterhead(doc, identity);
      doc.font('Helvetica-Bold').fontSize(13).text(pdfText(r.title));
      if (r.subtitle) doc.font('Helvetica').fontSize(9).text(pdfText(r.subtitle));
      doc.moveDown(0.5);
      const total = r.columns.reduce((s, c) => s + (c.width ?? 1), 0);
      const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const columns: Column[] = r.columns.map((c) => ({
        header: c.label,
        width: ((c.width ?? 1) / total) * available,
        align: c.type === 'money' ? 'right' : 'left',
      }));
      const rows = r.rows.map((line) =>
        r.columns.map((c) => {
          const v = line.cells[c.key];
          if (v === null || v === undefined || v === '') return '';
          return c.type === 'money' ? eur(v) : v;
        }),
      );
      table(doc, columns, rows, { fontSize: 8 });
    },
    { size: 'A4', margin: 36 },
  );
}
