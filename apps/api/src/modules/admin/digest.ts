import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { jobRun, member, type Db } from '@episoft/db';
import { addDays, decimalToCents } from '@episoft/shared';
import type { Config } from '../../config';
import { toParisDate } from '../../lib/dates';
import { notifyStaff } from '../../lib/alerts';
import { escapeHtml, queueEmail } from '../../lib/mail';
import { sendPush } from '../../lib/push';
import { eur } from '../../lib/pdf';
import { loadSettings } from './settings-store';
import { lastIntegrity, runIntegrityChecks, type IntegrityReport } from './integrity';
import { computeAttention } from './attention';
import { takeWalletSnapshot } from '../members/wallet-snapshot';

// Daily alerts (R-STK-07, R-CAG-06, integrity): one run per job and day, e-mail and push.

/**
 * Runs `fn` only the first time it is called for (name, day). The slot is freed when `fn`
 * fails or reports 0 (nothing to send), so something that appears later in the day still goes out.
 */
export async function runOncePerDay(
  db: Db,
  name: string,
  day: string,
  fn: () => Promise<number>,
): Promise<number | null> {
  const [claimed] = await db
    .insert(jobRun)
    .values({ name, day })
    .onConflictDoNothing()
    .returning({ name: jobRun.name });
  if (!claimed) return null;
  const release = () => db.delete(jobRun).where(and(eq(jobRun.name, name), eq(jobRun.day, day)));
  try {
    const n = await fn();
    if (n === 0) await release();
    return n;
  } catch (e) {
    await release();
    throw e;
  }
}

const fr = (iso: string) => iso.split('-').reverse().join('/');

/** R-STK-07: batches expired or expiring within `daysBefore` days, to the purchasing team. */
export async function sendExpiryDigest(
  db: Db,
  config: Config,
  now = new Date(),
  log?: FastifyBaseLogger,
): Promise<number> {
  const cfg = (await loadSettings(db))['stock.expiryAlert'];
  if (!cfg.enabled) return 0;
  const today = toParisDate(now);
  const sent = await runOncePerDay(db, 'expiry-digest', today, async () => {
    const rows = await db.execute<{ name: string; best_before: string; qty: string }>(sql`
      select p.name, b.best_before::text, b.qty::text
        from app.product_batch b join app.product p on p.id = b.product_id
       where b.best_before <= ${addDays(today, cfg.daysBefore)}::date
       order by b.best_before, p.name`);
    if (!rows.rows.length) return 0;
    const lines = rows.rows.map(
      (r) =>
        `${fr(r.best_before)}${r.best_before < today ? ' (périmé)' : ''} · ${r.name} · quantité ${Number(r.qty)}`,
    );
    await notifyStaff(
      db,
      config,
      ['APPROS'],
      { subject: `Épicafé : ${rows.rows.length} lot(s) à surveiller (dates limites)`, lines },
      {
        title: 'Dates limites',
        body: `${rows.rows.length} lot(s) périmé(s) ou proches de leur date.`,
        url: '/appros/stock',
      },
      log,
    );
    return rows.rows.length;
  });
  return sent ?? 0;
}

/**
 * R-CAG-06: households that bought with their cagnotte in the last 90 days and whose balance is
 * under the threshold get one reminder (e-mail to the referent, push to every device of the
 * household), then none for `everyDays` days.
 */
export async function sendLowWalletReminders(
  db: Db,
  config: Config,
  now = new Date(),
  log?: FastifyBaseLogger,
): Promise<number> {
  const cfg = (await loadSettings(db))['wallet.lowReminder'];
  if (!cfg.enabled) return 0;
  const today = toParisDate(now);
  const sent = await runOncePerDay(db, 'wallet-low', today, async () => {
    const due = await db.execute<{ household_id: string; balance: string }>(sql`
      select b.household_id, b.balance::text
        from app.household_balance b
       where b.balance < ${cfg.threshold}::numeric
         and exists (select 1 from app.wallet_entry w where w.household_id = b.household_id
                      and w.kind = 'PURCHASE' and w.at >= ${addDays(today, -90)}::date)
         and not exists (select 1 from app.wallet_low_notice n where n.household_id = b.household_id
                          and n.at >= ${addDays(today, -cfg.everyDays)}::date)`);
    let n = 0;
    for (const d of due.rows) {
      const people = await db
        .select({
          id: member.id,
          email: member.email,
          firstName: member.firstName,
          referent: sql<boolean>`${member.id} = (select referent_member_id from app.household where id = ${d.household_id})`,
        })
        .from(member)
        .where(and(eq(member.householdId, d.household_id), sql`${member.status} <> 'ARCHIVED'`));
      const negative = decimalToCents(d.balance) < 0;
      const body = negative
        ? `Votre cagnotte est négative (${eur(d.balance)}). Pensez à la recharger lors de votre prochain passage.`
        : `Votre cagnotte n’est plus que de ${eur(d.balance)}. Pensez à la recharger lors de votre prochain passage.`;
      const to = people.find((p) => p.referent && p.email) ?? people.find((p) => p.email);
      if (to?.email)
        await queueEmail(db, {
          to: to.email,
          subject: 'Épicafé : votre cagnotte est basse',
          text: `Bonjour ${to.firstName},\n\n${body}\n\nMerci !`,
          html: `<p>Bonjour ${escapeHtml(to.firstName)},</p><p>${escapeHtml(body)}</p><p>Merci !</p>`,
        });
      for (const p of people)
        await sendPush(db, config, p.id, { title: 'Épicafé', body, url: '/mon-foyer' }, log);
      await db.execute(
        sql`insert into app.wallet_low_notice (household_id, at) values (${d.household_id}, now())
            on conflict (household_id) do update set at = excluded.at`,
      );
      n++;
    }
    return n;
  });
  return sent ?? 0;
}

/** Integrity failures (errors only) are sent once a day to ADMIN and COMPTA. */
export async function sendIntegrityAlert(
  db: Db,
  config: Config,
  report: IntegrityReport,
  now = new Date(),
  log?: FastifyBaseLogger,
): Promise<number> {
  if (!report.errors) return 0;
  const sent = await runOncePerDay(db, 'integrity-alert', toParisDate(now), async () => {
    const failing = report.checks.filter((c) => c.severity === 'error' && c.count > 0);
    await notifyStaff(
      db,
      config,
      ['ADMIN', 'COMPTA'],
      {
        subject: `Épicafé : ${report.errors} contrôle(s) d’intégrité en échec`,
        lines: failing.map((c) => `${c.id} · ${c.label} : ${c.count}`),
      },
      {
        title: 'Contrôles d’intégrité',
        body: `${report.errors} contrôle(s) en échec.`,
        url: '/admin/controles',
      },
      log,
    );
    return failing.length;
  });
  return sent ?? 0;
}

/**
 * One summary a day for ADMIN and COMPTA: everything that deserves a look (refused tickets,
 * failed e-mails, late backup, tickets saved with a warning…). The integrity failures keep
 * their own message above, so they are not repeated here. Nothing to report, nothing sent.
 */
export async function sendAttentionSummary(
  db: Db,
  config: Config,
  now = new Date(),
  log?: FastifyBaseLogger,
): Promise<number> {
  const thresholds = (await loadSettings(db))['controls.thresholds'];
  const sent = await runOncePerDay(db, 'attention-summary', toParisDate(now), async () => {
    const items = (await computeAttention(db, thresholds, now)).filter(
      (i) => !i.code.startsWith('INTEGRITY'),
    );
    if (!items.length) return 0;
    await notifyStaff(
      db,
      config,
      ['ADMIN', 'COMPTA'],
      {
        subject: 'Épicafé : points à surveiller',
        lines: items.map((i) => `${i.count} · ${i.label}`),
      },
      {
        title: 'Points à surveiller',
        body: `${items.length} point(s) à regarder.`,
        url: '/',
      },
      log,
    );
    return items.length;
  });
  return sent ?? 0;
}

/** Hourly tick; each alert acts once per day, from 7 h (Paris). */
export function startDailyDigestJob(db: Db, config: Config, log: FastifyBaseLogger): () => void {
  const run = async () => {
    const now = new Date();
    if (
      Number(
        new Intl.DateTimeFormat('fr-FR', {
          hour: '2-digit',
          hour12: false,
          timeZone: 'Europe/Paris',
        }).format(now),
      ) < 7
    )
      return;
    try {
      const expiry = await sendExpiryDigest(db, config, now, log);
      const wallets = await sendLowWalletReminders(db, config, now, log);
      // After a restart the last result is gone: run the checks rather than miss the alert.
      const report = lastIntegrity() ?? (await runIntegrityChecks(db));
      const integrity = await sendIntegrityAlert(db, config, report, now, log);
      // The cagnotte balances noted every morning feed the check CAG-05.
      // One note per household and day: running it at every tick changes nothing.
      await takeWalletSnapshot(db, now);
      const attention = await sendAttentionSummary(db, config, now, log);
      if (expiry || wallets || integrity || attention)
        log.info({ expiry, wallets, integrity, attention }, 'alertes quotidiennes envoyées');
    } catch (err) {
      log.error({ err }, 'alertes quotidiennes');
    }
  };
  const timer = setInterval(() => void run(), 3600_000);
  const first = setTimeout(() => void run(), 90_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
