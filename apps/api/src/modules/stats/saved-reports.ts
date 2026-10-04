import { and, desc, eq, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { savedReport, type Db } from '@episoft/db';
import { hasAnyRole } from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { forbidden, notFound } from '../../lib/problem';

export const SAVED_REPORT_KINDS = [
  'sales',
  'payments',
  'purchases',
  'movements',
  'households',
  'dormant',
  'hours',
  'losses',
  'forecast',
] as const;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(SAVED_REPORT_KINDS),
  /** The filters of the screen, as text: never a query. */
  params: z.record(z.string().max(80), z.string().max(80)),
  shared: z.boolean().default(false),
});

/** R-STA-05 — a library of named, read-only reports: a fixed kind plus its filters. */
export const savedReportRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const stats = { preHandler: app.requireRoles('STATS') };

  app.get('/stats/saved-reports', stats, async (req) =>
    db
      .select()
      .from(savedReport)
      .where(or(eq(savedReport.shared, true), eq(savedReport.createdBy, req.user!.id)))
      .orderBy(desc(savedReport.createdAt)),
  );

  app.post('/stats/saved-reports', { ...stats, schema: { body: bodySchema } }, async (req) =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(savedReport)
        .values({ ...req.body, createdBy: req.user!.id })
        .returning();
      await audit(tx, req, {
        action: 'report.save',
        entity: 'saved_report',
        entityId: row!.id,
        after: req.body,
      });
      return row;
    }),
  );

  app.delete(
    '/stats/saved-reports/:id',
    { ...stats, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) =>
      db.transaction(async (tx) => {
        const [row] = await tx.select().from(savedReport).where(eq(savedReport.id, req.params.id));
        if (!row) throw notFound('Rapport introuvable.');
        if (row.createdBy !== req.user!.id && !hasAnyRole(req.user!.roles, ['ADMIN']))
          throw forbidden();
        await tx.delete(savedReport).where(and(eq(savedReport.id, row.id)));
        await audit(tx, req, {
          action: 'report.delete',
          entity: 'saved_report',
          entityId: row.id,
          before: row,
        });
        return { ok: true };
      }),
  );
};
