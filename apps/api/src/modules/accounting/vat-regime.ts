import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fiscalYear, vatRegimeChange, type Db } from '@episoft/db';
import { regimeAt, VAT_REGIMES, vatRegimeChangeProblem } from '@episoft/shared';
import { audit } from '../../lib/audit';
import { toShopDate } from '../../lib/dates';
import { badRequest } from '../../lib/problem';
import { loadRegimeChanges } from '../../lib/vat-regime';

/** R-TVA-07: the VAT regime of the association, effective from a date, with its history. */
export const vatRegimeRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const readers = { preHandler: app.requireRoles('ADMIN', 'COMPTA', 'APPROS') };
  const editors = { preHandler: app.requireRoles('ADMIN', 'COMPTA') };

  app.get('/vat-regime', readers, async () => {
    const changes = await loadRegimeChanges(db);
    return { current: regimeAt(changes, toShopDate(new Date())), changes };
  });

  app.post(
    '/vat-regime',
    {
      ...editors,
      schema: {
        body: z.object({
          regime: z.enum(VAT_REGIMES),
          effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide.'),
        }),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const existing = await loadRegimeChanges(tx);
        const closed = await tx.select().from(fiscalYear).where(eq(fiscalYear.status, 'CLOSED'));
        const problem = vatRegimeChangeProblem(req.body, existing, closed);
        if (problem) throw badRequest(problem);
        const [row] = await tx
          .insert(vatRegimeChange)
          .values({ ...req.body, createdBy: req.user!.id })
          .returning();
        await audit(tx, req, {
          action: 'vat_regime.change',
          entity: 'vat_regime_change',
          entityId: row!.id,
          after: row,
        });
        return { current: regimeAt(await loadRegimeChanges(tx), toShopDate(new Date())) };
      }),
  );
};
