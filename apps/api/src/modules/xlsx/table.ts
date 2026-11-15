import ExcelJS from 'exceljs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '@episoft/db';
import {
  canExport,
  exportFileName,
  exportRolesOf,
  tableExportSchema,
  type TableExport,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toShopDate } from '../../lib/dates';
import { forbidden } from '../../lib/problem';

/** Excel's own limits on a sheet name. */
const sheetName = (title: string) =>
  title
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31) || 'Export';

/**
 * A date or a date with time of the list, as Excel stores it: the wall clock of the list is kept
 * (UTC is only the carrier), so that Excel shows exactly what the screen showed.
 */
const toExcelDate = (v: string) => new Date(v.length === 10 ? `${v}T00:00:00Z` : `${v}:00Z`);

export async function tableXlsx(t: TableExport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName(t.title));
  ws.columns = t.columns.map((c, j) => {
    const longest = Math.max(
      c.header.length,
      ...t.rows.slice(0, 200).map((r) => String(r[j] ?? '').length),
    );
    return {
      header: c.header,
      key: `c${j}`,
      width: Math.min(60, Math.max(10, longest + 2)),
      style: {
        ...(c.type === 'money' ? { numFmt: '#,##0.00 €' } : {}),
        ...(c.type === 'number' ? { numFmt: '#,##0.##' } : {}),
        ...(c.type === 'date' ? { numFmt: 'dd/mm/yyyy' } : {}),
        ...(c.type === 'datetime' ? { numFmt: 'dd/mm/yyyy hh:mm' } : {}),
      },
    };
  });
  ws.getRow(1).font = { bold: true };
  for (const row of t.rows)
    ws.addRow(
      row.map((v, j) => {
        const type = t.columns[j]!.type;
        if (v === null) return null;
        if (type === 'date' || type === 'datetime') return toExcelDate(String(v));
        // A text is written as a text: a cell starting with « = » stays a text, never a formula.
        return v;
      }),
    );
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (t.rows.length)
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * « Exporter en Excel » on every list. The browser sends what the list shows (filters and sort
 * applied) and the server writes the file; nothing is read from the database, so it cannot give
 * more than what the person already sees.
 *
 * Access follows the role of the screen the export comes from (`scope`, see EXPORT_SCOPES): the
 * role that opens the screen, and an administrator. The server cannot prove where the rows come
 * from, so what it guarantees is the role, the size and the type of every cell, and a record of
 * every file in the journal (who, from which screen, how many rows). Not a till route: while
 * another cashier keeps the till with the session, exports are closed like the rest.
 */
export const tableExportRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  app.post(
    '/exports/table',
    {
      schema: { body: tableExportSchema },
      // Large lists are a few hundred kilobytes of JSON: above this, it is not a list.
      bodyLimit: 6 * 1024 * 1024,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const b = req.body;
      if (!canExport(req.user!.roles, b.scope))
        throw forbidden(
          `L’export de cet écran est réservé à : ${exportRolesOf(b.scope).join(', ') || 'tout le monde'}.`,
        );
      const file = exportFileName(b.title, toShopDate(new Date()));
      const buf = await tableXlsx(b);
      await audit(db, req, {
        action: 'export.file',
        entity: 'file',
        after: {
          file,
          scope: b.scope,
          rows: b.rows.length,
          columns: b.columns.length,
          url: 'table',
        },
      });
      return reply
        .header('content-disposition', `attachment; filename="${file}"`)
        .header('cache-control', 'private, no-store')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buf);
    },
  );
};
