import { eq, inArray } from 'drizzle-orm';
import webpush from 'web-push';
import type { FastifyBaseLogger } from 'fastify';
import { auditSystem } from './audit';
import { pushSubscription, type Db } from '@episoft/db';
import type { Config } from '../config';

// Web Push (§4.16): a best-effort notification next to the e-mail. Without VAPID keys it does nothing.

export interface PushMessage {
  title: string;
  body: string;
  /** Page opened when the notification is clicked. */
  url?: string;
}

export const pushEnabled = (config: Config) =>
  !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);

/** Sends to every device of the member; dead subscriptions (404/410) are forgotten. Never throws. */
export async function sendPush(
  db: Db,
  config: Config,
  memberId: string,
  message: PushMessage,
  log?: FastifyBaseLogger,
): Promise<number> {
  if (!pushEnabled(config)) return 0;
  try {
    const subs = await db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.memberId, memberId));
    const gone: string[] = [];
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(message),
            {
              vapidDetails: {
                subject: config.VAPID_SUBJECT,
                publicKey: config.VAPID_PUBLIC_KEY!,
                privateKey: config.VAPID_PRIVATE_KEY!,
              },
              TTL: 24 * 3600,
            },
          );
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) gone.push(s.id);
          else log?.warn({ err: e }, 'push failed');
        }
      }),
    );
    if (gone.length)
      await db.transaction(async (tx) => {
        await tx.delete(pushSubscription).where(inArray(pushSubscription.id, gone));
        await auditSystem(tx, {
          action: 'push.expired',
          entity: 'member',
          entityId: memberId,
          after: { devices: gone.length },
        });
      });
    return sent;
  } catch (e) {
    log?.warn({ err: e }, 'push failed');
    return 0;
  }
}
