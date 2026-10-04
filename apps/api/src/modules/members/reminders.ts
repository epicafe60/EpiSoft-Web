import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { household, member, membershipReminder, type Db } from '@episoft/db';
import { addDays } from '@episoft/shared';
import type { Config } from '../../config';
import { toParisDate } from '../../lib/dates';
import { sendPush } from '../../lib/push';
import { escapeHtml, queueEmail } from '../../lib/mail';
import { loadSettings } from '../admin/settings-store';

/**
 * R-ADH-04: e-mails households whose membership ends in `daysBefore` days (or less, if a
 * run was missed) and that have not renewed. Each membership is reminded once.
 * Returns the number of e-mails queued.
 */
export async function sendMembershipReminders(
  db: Db,
  now = new Date(),
  config?: Config,
): Promise<number> {
  const settings = await loadSettings(db);
  const cfg = settings['membership.reminder'];
  if (!cfg.enabled) return 0;
  const today = toParisDate(now);
  const limit = addDays(today, cfg.daysBefore);

  const pushes: { memberId: string; end: string }[] = [];
  const sent = await db.transaction(async (tx) => {
    // Latest membership of each household, ending between today and the limit, not reminded.
    const due = await tx.execute<{
      membership_id: string;
      household_id: string;
      end_date: string;
    }>(sql`
      select m.id as membership_id, m.household_id, m.end_date
        from app.membership m
       where m.cancelled_at is null
         and m.end_date between ${today}::date and ${limit}::date
         and not exists (select 1 from app.membership n where n.household_id = m.household_id
                           and n.cancelled_at is null and n.end_date > m.end_date)
         and not exists (select 1 from app.membership_reminder r where r.membership_id = m.id)
       for update of m skip locked`);
    let sent = 0;
    for (const d of due.rows) {
      const h = await tx.query.household.findFirst({ where: eq(household.id, d.household_id) });
      const referent = h?.referentMemberId
        ? await tx.query.member.findFirst({ where: eq(member.id, h.referentMemberId) })
        : undefined;
      const to =
        referent?.email && referent.status !== 'ARCHIVED'
          ? referent
          : await tx.query.member.findFirst({
              where: and(
                eq(member.householdId, d.household_id),
                sql`${member.email} is not null`,
                sql`${member.status} <> 'ARCHIVED'`,
              ),
            });
      const people = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.householdId, d.household_id), sql`${member.status} <> 'ARCHIVED'`));
      for (const p of people) pushes.push({ memberId: p.id, end: d.end_date });
      await tx
        .insert(membershipReminder)
        .values({ membershipId: d.membership_id, to: to?.email ?? null });
      if (!to?.email) continue;
      const end = d.end_date.split('-').reverse().join('/');
      await queueEmail(tx, {
        to: to.email,
        subject: 'Épicafé : votre adhésion arrive à échéance',
        text: `Bonjour ${to.firstName},\n\nL’adhésion de votre foyer à l’Épicafé se termine le ${end}. Vous pouvez la renouveler à la caisse lors de votre prochain passage.\n\nMerci de votre soutien !`,
        html: `<p>Bonjour ${escapeHtml(to.firstName)},</p><p>L’adhésion de votre foyer à l’Épicafé se termine le <strong>${end}</strong>. Vous pouvez la renouveler à la caisse lors de votre prochain passage.</p><p>Merci de votre soutien !</p>`,
      });
      sent++;
    }
    return sent;
  });
  // Push is best effort, after the commit, and also reaches households without an e-mail address.
  if (config)
    for (const p of pushes)
      await sendPush(db, config, p.memberId, {
        title: 'Épicafé',
        body: `Votre adhésion se termine le ${p.end.split('-').reverse().join('/')}.`,
        url: '/mon-foyer',
      });
  return sent;
}

/** Runs the reminders every hour; the job itself only acts once per membership. */
export function startReminderJob(db: Db, log: FastifyBaseLogger, config?: Config): () => void {
  const run = () =>
    sendMembershipReminders(db, new Date(), config)
      .then((n) => n && log.info({ n }, 'relances d’adhésion envoyées'))
      .catch((err) => log.error({ err }, 'relances d’adhésion'));
  const timer = setInterval(run, 3600_000);
  void run();
  return () => clearInterval(timer);
}
