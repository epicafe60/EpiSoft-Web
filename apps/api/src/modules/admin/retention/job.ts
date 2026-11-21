import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@episoft/db';
import { shopFormat } from '@episoft/shared';
import type { Config } from '../../../config';
import { auditSystem } from '../../../lib/audit';
import { toShopDate } from '../../../lib/dates';
import { runOncePerDay } from '../digest';
import { loadSettings } from '../settings-store';
import { ARCHIVE_NAME, purgeState, runPurge } from './engine';
import { anonymizeInactive } from './inactive-members';
import { weeklySnapshot } from './size';

/** Where the archives of the purges are put (and read from). */
export const archiveDir = (config: Config) => resolve(config.ARCHIVE_DIR ?? 'archives');

/** An archive holds personal data: it is not kept beyond this, whatever the administrators do. */
export const ARCHIVE_KEEP_DAYS = 30;
/** Members anonymised by one nightly run (the rest goes the following nights). */
const NIGHTLY_ANONYMIZE_LIMIT = 200;
/** A nightly purge stops starting batches after this long; what is left goes the next night. */
const NIGHTLY_MAX_MS = 30 * 60_000;

/** Deletes the archives older than ARCHIVE_KEEP_DAYS. Returns how many. */
export function removeOldArchives(dir: string, now = new Date()): number {
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!ARCHIVE_NAME.test(f)) continue;
      const p = join(dir, f);
      if (now.getTime() - statSync(p).mtimeMs > ARCHIVE_KEEP_DAYS * 86_400_000) {
        unlinkSync(p);
        n++;
      }
    }
  } catch {
    // no folder yet: nothing to remove
  }
  return n;
}

/**
 * The nightly run (ADR 0017): the weekly size snapshot, the anonymisation of inactive members and
 * the purge, each only if the administrators turned it on. Once per day. Returns the number of
 * rows purged plus members anonymised (null: already done today).
 */
export async function runNightlyRetention(
  db: Db,
  config: Config,
  now = new Date(),
  log?: FastifyBaseLogger,
): Promise<number | null> {
  await weeklySnapshot(db, now);
  const cfg = (await loadSettings(db))['data.retention'];
  if (!cfg.nightly && !cfg.anonymization.enabled) return 0;
  if (purgeState.running) return 0;
  return runOncePerDay(db, 'retention', toShopDate(now), async () => {
    let anonymized = 0;
    if (cfg.anonymization.enabled) {
      anonymized = await anonymizeInactive(
        db,
        cfg.anonymization.years,
        now,
        (tx, m) =>
          auditSystem(tx, {
            action: 'member.anonymize',
            entity: 'member',
            entityId: m.id,
            after: { automatic: true, inactiveYears: cfg.anonymization.years },
          }),
        { limit: NIGHTLY_ANONYMIZE_LIMIT },
      );
    }
    let rows = 0;
    if (cfg.nightly) {
      const summary = await runPurge(db, cfg, now, {
        archive: cfg.archiveBeforePurge,
        archiveDir: archiveDir(config),
        trigger: 'nightly',
        maxMs: NIGHTLY_MAX_MS,
        anonymized,
        record: (tx, s) =>
          auditSystem(tx, { action: 'retention.purge', entity: 'retention', after: s }),
      });
      rows = summary.total;
      if (summary.error) log?.error({ error: summary.error }, 'purge de nuit');
      removeOldArchives(archiveDir(config), now);
      if (!summary.total && anonymized)
        await auditSystem(db, {
          action: 'retention.purge',
          entity: 'retention',
          after: { trigger: 'nightly', total: 0, classes: [], anonymized },
        });
    } else if (anonymized) {
      await auditSystem(db, {
        action: 'retention.purge',
        entity: 'retention',
        after: { trigger: 'nightly', total: 0, classes: [], anonymized },
      });
    }
    log?.info({ rows, anonymized }, 'conservation des données');
    return rows + anonymized;
  });
}

/** Hourly tick; the run happens at night (2 h to 5 h, shop time), once per day. */
export function startRetentionJob(db: Db, config: Config, log: FastifyBaseLogger): () => void {
  const run = async () => {
    const hour = Number(shopFormat('fr-FR', { hour: '2-digit', hour12: false }).format(new Date()));
    if (hour < 2 || hour >= 5) {
      // Outside the night only the weekly size snapshot is taken (it costs nothing).
      try {
        await weeklySnapshot(db, new Date());
      } catch (err) {
        log.error({ err }, 'relevé de taille de la base');
      }
      return;
    }
    try {
      await runNightlyRetention(db, config, new Date(), log);
    } catch (err) {
      log.error({ err }, 'conservation des données');
    }
  };
  const timer = setInterval(() => void run(), 3600_000);
  const first = setTimeout(() => void run(), 120_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
