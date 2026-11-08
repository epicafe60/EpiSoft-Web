import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '@episoft/db';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';

type Row = Record<string, unknown>;

/** Never leave the server: credentials, sessions, mail queue and binary media. */
const EXCLUDED_TABLES = new Set(['session', 'password_reset_token', 'email_outbox', 'media']);
const SENSITIVE_COLUMN = /hash|token|secret|salt|password/i;

const cell = (v: unknown) =>
  v === null || v === undefined
    ? null
    : v instanceof Date || typeof v === 'number' || typeof v === 'boolean'
      ? v
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);

/** R-STA-04 — full database export, one sheet per table (ADMIN only, audited). */
export const exportRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  // Reads the whole database: a few a minute is plenty for a person, a loop is stopped.
  app.get(
    '/admin/export.xlsx',
    {
      preHandler: app.requireRoles('ADMIN'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const cols = (
        await db.execute(sql`
        select table_name, column_name from information_schema.columns
        where table_schema = 'app' order by table_name, ordinal_position`)
      ).rows as Row[];
      const tables = new Map<string, string[]>();
      for (const c of cols) {
        const t = String(c.table_name);
        const name = String(c.column_name);
        if (EXCLUDED_TABLES.has(t) || SENSITIVE_COLUMN.test(name)) continue;
        tables.set(t, [...(tables.get(t) ?? []), name]);
      }

      await audit(db, req, {
        action: 'export.full',
        entity: 'database',
        after: { tables: tables.size },
      });

      const out = new PassThrough();
      const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true });
      void (async () => {
        try {
          for (const [table, columns] of tables) {
            const ws = wb.addWorksheet(table.slice(0, 31), {
              views: [{ state: 'frozen', ySplit: 1 }],
            });
            ws.columns = columns.map((c) => ({
              header: c,
              key: c,
              width: Math.max(10, c.length + 2),
            }));
            ws.getRow(1).font = { bold: true };
            ws.getRow(1).commit();
            const res = await db.execute(
              sql`select ${sql.join(
                columns.map((c) => sql.identifier(c)),
                sql`, `,
              )} from ${sql.identifier('app')}.${sql.identifier(table)}`,
            );
            for (const r of res.rows as Row[])
              ws.addRow(Object.fromEntries(columns.map((c) => [c, cell(r[c])]))).commit();
            ws.commit();
          }
          await wb.commit();
        } catch (e) {
          out.destroy(e as Error);
        }
      })();
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-disposition', `attachment; filename="episoft-export-${day}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(out);
    },
  );
};
