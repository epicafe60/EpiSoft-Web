import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { jobRun, member, userRole, type Db, type DbOrTx } from '@episoft/db';
import type { RoleCode } from '@episoft/shared';
import type { Config } from '../config';
import { auditSystem } from './audit';
import { escapeHtml, queueEmail } from './mail';
import { sendPush, type PushMessage } from './push';

/** Active members holding at least one of the roles. */
export async function staffWith(db: DbOrTx, roles: RoleCode[]) {
  return db
    .selectDistinct({ id: member.id, email: member.email })
    .from(member)
    .innerJoin(userRole, eq(userRole.memberId, member.id))
    .where(and(inArray(userRole.roleCode, roles), sql`${member.status} <> 'ARCHIVED'`));
}

/** One e-mail (when an address is known) and one push per recipient. Returns the recipients. */
export async function notifyStaff(
  db: Db,
  config: Config,
  roles: RoleCode[],
  mail: { subject: string; lines: string[] },
  push: PushMessage,
  log?: FastifyBaseLogger,
): Promise<number> {
  const staff = await staffWith(db, roles);
  await db.transaction(async (tx) => {
    for (const s of staff)
      if (s.email)
        await queueEmail(tx, {
          to: s.email,
          subject: mail.subject,
          text: mail.lines.join('\n'),
          html: `<ul>${mail.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
        });
    await auditSystem(tx, {
      action: 'staff.notified',
      entity: 'email_outbox',
      after: { subject: mail.subject, recipients: staff.length },
    });
  });
  for (const s of staff) await sendPush(db, config, s.id, push, log);
  return staff.length;
}

/**
 * An alert that cannot wait for the daily summary (a refused ticket, a missed backup, a burst of
 * server errors). At most one per hour for the same subject: the first one is enough to look.
 * Returns the number of recipients, 0 when it was held back.
 */
export async function alertNow(
  db: Db,
  config: Config,
  roles: RoleCode[],
  mail: { subject: string; lines: string[] },
  push: PushMessage,
  log?: FastifyBaseLogger,
  now = new Date(),
): Promise<number> {
  // One slot per subject and hour, claimed in the database: holds even when nobody has an
  // e-mail address (push only) and whatever the number of API processes.
  const hour = now.toISOString().slice(0, 13);
  const [claimed] = await db
    .insert(jobRun)
    .values({ name: `alert:${mail.subject}:${hour}`, day: now.toISOString().slice(0, 10) })
    .onConflictDoNothing()
    .returning({ name: jobRun.name });
  if (!claimed) return 0;
  return notifyStaff(db, config, roles, mail, push, log);
}
