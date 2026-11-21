import { desc } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fiscalJournal, periodClosing, type Db } from '@episoft/db';
import { pendingClosings, verifyArchive, type FiscalArchive } from '@episoft/shared';
import type { Config } from '../../config';
import { audit, auditSystem } from '../../lib/audit';
import { toShopDate } from '../../lib/dates';
import { buildFiscalArchive } from './archive';
import { fiscalFindings } from './integrity';
import { fiscalSealKey } from './journal';
import { closePeriod } from './periods';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { cashSession, sale } from '@episoft/db';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');

export const fiscalRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const treasury = { preHandler: app.requireRoles('ADMIN', 'COMPTA') };
  const admin = { preHandler: app.requireRoles('ADMIN') };

  /** The closings, newest first. */
  app.get('/fiscal/closings', treasury, async () => {
    const rows = await db
      .select()
      .from(periodClosing)
      .orderBy(desc(periodClosing.periodStart), desc(periodClosing.kind));
    return rows.map((c) => ({ ...c, closedAt: c.closedAt.toISOString() }));
  });

  /**
   * What is left to close, and what can be closed now: the rules of the closings, as the screen
   * shows them (packages/shared closings-pending.ts).
   */
  app.get('/fiscal/closings/pending', treasury, async () => {
    const today = toShopDate(new Date());
    const days = await db
      .select({ day: sale.accountingDay, tickets: sql<number>`count(*)::int` })
      .from(sale)
      .groupBy(sale.accountingDay);
    const closings = await db
      .select({ kind: periodClosing.kind, start: periodClosing.periodStart })
      .from(periodClosing);
    const open = await db
      .select({ openedAt: cashSession.openedAt })
      .from(cashSession)
      .where(eq(cashSession.status, 'OPEN'));
    const startsOf = (kind: string) => closings.filter((c) => c.kind === kind).map((c) => c.start);
    return {
      today,
      openSessions: open.length,
      items: pendingClosings({
        today,
        salesByDay: days,
        closed: { DAY: startsOf('DAY'), MONTH: startsOf('MONTH'), YEAR: startsOf('YEAR') },
        openSessionDays: open.map((o) => toShopDate(o.openedAt)),
      }),
    };
  });

  /** « Z »: closes a day, a month or a year. Final: there is no way back. */
  app.post(
    '/fiscal/closings',
    {
      ...treasury,
      schema: { body: z.object({ kind: z.enum(['DAY', 'MONTH', 'YEAR']), start: day }) },
    },
    async (req) => {
      const row = await db.transaction(async (tx) => {
        const c = await closePeriod(tx, {
          kind: req.body.kind,
          start: req.body.start,
          by: req.user!.id,
        });
        await audit(tx, req, {
          action: 'period.close',
          entity: 'period_closing',
          entityId: c.id,
          after: {
            kind: c.kind,
            start: c.periodStart,
            tickets: c.tickets,
            netTotal: c.netTotal,
            grandTotal: c.grandTotal,
          },
        });
        return c;
      });
      return { ...row, closedAt: row.closedAt.toISOString() };
    },
  );

  /** The controller's check: recomputes the chain, the tickets and the closings. */
  app.get('/admin/fiscal/verify', treasury, async () => {
    const [last] = await db.select().from(fiscalJournal).orderBy(desc(fiscalJournal.seq)).limit(1);
    const findings = await fiscalFindings(db);
    return {
      at: new Date().toISOString(),
      signed: fiscalSealKey() !== null,
      entries: last?.seq ?? 0,
      lastHash: last?.hash ?? null,
      ok: findings.every((f) => f.severity !== 'error' || f.rows.length === 0),
      findings: findings.filter((f) => f.rows.length > 0),
    };
  });

  /** The archive of a period: signed JSON, to keep outside the server (ADR 0016 §8). */
  app.get(
    '/admin/fiscal/archive',
    { ...admin, schema: { querystring: z.object({ from: day, to: day }) } },
    async (req, reply) => {
      if (req.query.from > req.query.to)
        return reply.code(400).send({ detail: 'La date de début suit la date de fin.' });
      const archive = await db.transaction(async (tx) => {
        const a = await buildFiscalArchive(tx, req.query.from, req.query.to);
        await audit(tx, req, {
          action: 'fiscal.archive',
          entity: 'fiscal_archive',
          after: {
            from: req.query.from,
            to: req.query.to,
            sales: a.manifest.counts.sales,
            journal: a.manifest.counts.journal,
            signed: a.signature !== null,
          },
        });
        return a;
      });
      return reply
        .header(
          'content-disposition',
          `attachment; filename="archive-fiscale-${req.query.from}-${req.query.to}.json"`,
        )
        .type('application/json')
        .send(JSON.stringify(archive));
    },
  );

  /** Verifies an archive file (the server's key is used for the signatures). */
  app.post(
    '/admin/fiscal/archive/verify',
    { ...admin, bodyLimit: 64 * 1024 * 1024, schema: { body: z.looseObject({}) } },
    async (req) => verifyArchive(req.body as unknown as FiscalArchive, fiscalSealKey()),
  );
};

/**
 * ADR 0016 §3: closes, every night, the days gone by whose drawers are all closed, in order. A day
 * with a drawer still open stops the run (it is closed by a person once the drawer is). Failures
 * are logged, never thrown.
 */
export async function autoCloseDays(db: Db, now = new Date()): Promise<number> {
  const today = toShopDate(now);
  let closed = 0;
  for (;;) {
    const next = await db.transaction(async (tx) => {
      const [lastClosed] = await tx
        .select({ d: periodClosing.periodStart })
        .from(periodClosing)
        .where(eq(periodClosing.kind, 'DAY'))
        .orderBy(desc(periodClosing.periodStart))
        .limit(1);
      const [first] = await tx
        .select({ d: sale.accountingDay })
        .from(sale)
        .where(
          and(
            lastClosed ? gte(sale.accountingDay, lastClosed.d) : sql`true`,
            sql`${sale.accountingDay} not in (select period_start from app.period_closing where kind = 'DAY')`,
            lt(sale.accountingDay, today),
          ),
        )
        .orderBy(asc(sale.accountingDay))
        .limit(1);
      if (!first) return null;
      const open = await tx
        .select({ id: cashSession.id })
        .from(cashSession)
        .where(eq(cashSession.status, 'OPEN'))
        .limit(1);
      if (open.length) return null;
      const c = await closePeriod(tx, { kind: 'DAY', start: first.d, by: null, now });
      await auditSystem(tx, {
        action: 'period.close',
        entity: 'period_closing',
        entityId: c.id,
        after: {
          kind: c.kind,
          start: c.periodStart,
          tickets: c.tickets,
          netTotal: c.netTotal,
          grandTotal: c.grandTotal,
          automatic: true,
        },
      });
      return c.id;
    });
    if (!next) return closed;
    closed++;
  }
}

export function startFiscalClosingJob(db: Db, log: FastifyBaseLogger): () => void {
  const run = () =>
    autoCloseDays(db)
      .then((n) => n && log.info({ days: n }, 'clôture automatique des journées de caisse'))
      .catch((err) => log.error({ err }, 'clôture automatique des journées de caisse'));
  const first = setTimeout(run, 120_000);
  const timer = setInterval(run, 3600_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
