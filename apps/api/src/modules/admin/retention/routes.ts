import { createReadStream, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { desc } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { dbSizeSnapshot, type Db } from '@episoft/db';
import { RETENTION_CLASS_IDS } from '@episoft/shared';
import type { Config } from '../../../config';
import { audit } from '../../../lib/audit';
import { conflict, notFound } from '../../../lib/problem';
import { loadSettings } from '../settings-store';
import { ARCHIVE_NAME, buildPlan, planByClass, purgeState, runPurge } from './engine';
import { anonymizeInactive, EXCLUSION_LABELS, inactiveMembers } from './inactive-members';
import { archiveDir, ARCHIVE_KEEP_DAYS } from './job';
import { diskSpace, tableSizes, totalDatabaseBytes } from './size';

// Administration › Base de données and the retention policy (ADR 0017). ADMIN only.

const serializeState = () => ({
  running: purgeState.running,
  trigger: purgeState.trigger,
  startedAt: purgeState.startedAt?.toISOString() ?? null,
  current: purgeState.current,
  rows: purgeState.rows,
  last: purgeState.last,
});

export const retentionRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const admin = { preHandler: app.requireRoles('ADMIN') };

  /** The dry run: what a purge would remove now, per class, and who would be anonymised. */
  app.get('/admin/retention/preview', admin, async () => {
    const cfg = (await loadSettings(db))['data.retention'];
    const classes = planByClass(await buildPlan(db, cfg, new Date()));
    const inactive = await inactiveMembers(db, cfg.anonymization.years, new Date());
    return {
      at: new Date().toISOString(),
      classes: classes.map((c) => ({ ...c, cutoff: c.cutoff?.toISOString() ?? null })),
      totalRows: classes.reduce((a, c) => a + c.rows, 0),
      totalBytes: classes.reduce((a, c) => a + c.bytes, 0),
      anonymization: {
        enabled: cfg.anonymization.enabled,
        years: cfg.anonymization.years,
        candidates: inactive.candidates.length,
        excluded: inactive.excluded.length,
      },
    };
  });

  app.get('/admin/retention/status', admin, async () => serializeState());

  /**
   * « Purger maintenant ». The purge runs in the background (it can take minutes on a large
   * journal); the screen follows it with /status. The journal entry is written when it ends.
   */
  app.post(
    '/admin/retention/purge',
    {
      ...admin,
      schema: {
        body: z.object({
          confirm: z.literal(true),
          classIds: z.array(z.enum(RETENTION_CLASS_IDS as [string, ...string[]])).optional(),
          archive: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      if (purgeState.running) throw conflict('Une purge est déjà en cours.');
      const cfg = (await loadSettings(db))['data.retention'];
      const run = runPurge(db, cfg, new Date(), {
        classIds: req.body.classIds,
        archive: req.body.archive ?? cfg.archiveBeforePurge,
        archiveDir: archiveDir(config),
        trigger: 'manual',
        record: (tx, summary) =>
          audit(tx, req, { action: 'retention.purge', entity: 'retention', after: summary }),
      });
      run.catch((err) => app.log.error({ err }, 'purge manuelle'));
      void reply.code(202);
      return { started: true };
    },
  );

  // --- Inactive members (spec Q8) ---------------------------------------------------------

  app.get(
    '/admin/retention/inactive-members',
    { ...admin, schema: { querystring: z.object({ years: z.coerce.number().int().min(1).max(30).optional() }) } },
    async (req) => {
      const cfg = (await loadSettings(db))['data.retention'];
      const report = await inactiveMembers(db, req.query.years ?? cfg.anonymization.years, new Date());
      return {
        ...report,
        excluded: report.excluded.map((r) => ({
          ...r,
          reasons: r.excluded.map((e) => EXCLUSION_LABELS[e]),
        })),
      };
    },
  );

  app.post(
    '/admin/retention/anonymize',
    {
      ...admin,
      schema: {
        body: z.object({ confirm: z.literal(true), ids: z.array(z.string().uuid()).max(500).optional() }),
      },
    },
    async (req) => {
      const cfg = (await loadSettings(db))['data.retention'];
      const anonymized = await anonymizeInactive(
        db,
        cfg.anonymization.years,
        new Date(),
        (tx, m) =>
          audit(tx, req, {
            action: 'member.anonymize',
            entity: 'member',
            entityId: m.id,
            after: { inactiveYears: cfg.anonymization.years },
          }),
        { ids: req.body.ids },
      );
      return { anonymized };
    },
  );

  // --- Archives of the purges ---------------------------------------------------------------

  const files = () => {
    const dir = archiveDir(config);
    try {
      return readdirSync(dir)
        .filter((f) => ARCHIVE_NAME.test(f))
        .map((name) => {
          const s = statSync(join(dir, name));
          return { name, bytes: s.size, at: s.mtime.toISOString() };
        })
        .sort((a, b) => b.at.localeCompare(a.at));
    } catch {
      return [];
    }
  };

  app.get('/admin/retention/archives', admin, async () => ({
    keepDays: ARCHIVE_KEEP_DAYS,
    files: files(),
  }));

  const nameParams = { params: z.object({ name: z.string().regex(ARCHIVE_NAME) }) };

  app.get('/admin/retention/archives/:name', { ...admin, schema: nameParams }, async (req, reply) => {
    if (!files().some((f) => f.name === req.params.name)) throw notFound('Archive introuvable.');
    void reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${req.params.name}"`);
    return createReadStream(join(archiveDir(config), req.params.name));
  });

  app.delete('/admin/retention/archives/:name', { ...admin, schema: nameParams }, async (req) => {
    if (!files().some((f) => f.name === req.params.name)) throw notFound('Archive introuvable.');
    unlinkSync(join(archiveDir(config), req.params.name));
    await db.transaction(async (tx) => {
      await audit(tx, req, {
        action: 'retention.archive_delete',
        entity: 'retention',
        after: { file: req.params.name },
      });
    });
    return { ok: true };
  });

  // --- Size of the database -------------------------------------------------------------------

  app.get('/admin/database', admin, async () => {
    const cfg = (await loadSettings(db))['data.retention'];
    const [bytes, tables, disk, snapshots, plan] = await Promise.all([
      totalDatabaseBytes(db),
      tableSizes(db),
      diskSpace(),
      db
        .select({ at: dbSizeSnapshot.at, totalBytes: dbSizeSnapshot.totalBytes, reason: dbSizeSnapshot.reason })
        .from(dbSizeSnapshot)
        .orderBy(desc(dbSizeSnapshot.at))
        .limit(120),
      buildPlan(db, cfg, new Date()),
    ]);
    const classes = planByClass(plan);
    return {
      bytes,
      tables,
      disk,
      snapshots: snapshots.reverse().map((s) => ({ ...s, at: s.at.toISOString() })),
      estimate: {
        rows: classes.reduce((a, c) => a + c.rows, 0),
        bytes: classes.reduce((a, c) => a + c.bytes, 0),
      },
      alerts: cfg.alerts,
      overThreshold: cfg.alerts.dbSizeMb !== null && bytes > cfg.alerts.dbSizeMb * 1024 * 1024,
      diskLow: cfg.alerts.diskFreePct !== null && !!disk && disk.freePct < cfg.alerts.diskFreePct,
      // Space freed by deletions is reused by PostgreSQL but not given back to the disk.
      vacuum: tables
        .filter((t) => t.deadRows > 10_000 && t.deadRows > (t.rows + t.deadRows) * 0.2)
        .map((t) => ({ table: t.name, deadRows: t.deadRows, rows: t.rows })),
      lastPurge: purgeState.last,
    };
  });
};
