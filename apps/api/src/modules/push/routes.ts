import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pushSubscription, type Db } from '@episoft/db';
import { MAX_PUSH_DEVICES, pushEndpointAllowed } from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { pushEnabled } from '../../lib/push';

const subscription = z.object({
  // S07: only the push services of the browsers (the server calls this address).
  endpoint: z
    .string()
    .max(1000)
    .refine(pushEndpointAllowed, 'Service de notification non reconnu.'),
  keys: z.object({
    p256dh: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+=*$/),
    auth: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+=*$/),
  }),
});

export const pushRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  /** The public VAPID key, or null when push is not configured on this server. */
  app.get('/push/key', async () => ({
    publicKey: pushEnabled(config) ? config.VAPID_PUBLIC_KEY! : null,
  }));

  app.post('/push/subscribe', { schema: { body: subscription } }, async (req) => {
    const { endpoint, keys } = req.body;
    await db.transaction(async (tx) => {
      // The page subscribes again at every visit: only a new or changed subscription is recorded.
      const changed = await tx
        .insert(pushSubscription)
        .values({ memberId: req.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth })
        .onConflictDoUpdate({
          target: pushSubscription.endpoint,
          set: { memberId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth },
          setWhere: sql`(${pushSubscription.memberId}, ${pushSubscription.p256dh}, ${pushSubscription.auth})
            is distinct from (excluded.member_id, excluded.p256dh, excluded.auth)`,
        })
        .returning({ id: pushSubscription.id });
      // S07: a bounded number of devices per account, the most recent ones.
      const extra = await tx
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .where(eq(pushSubscription.memberId, req.user!.id))
        .orderBy(desc(pushSubscription.createdAt), desc(pushSubscription.id))
        .offset(MAX_PUSH_DEVICES);
      if (extra.length)
        await tx.delete(pushSubscription).where(
          inArray(
            pushSubscription.id,
            extra.map((r) => r.id),
          ),
        );
      if (changed.length)
        await audit(tx, req, {
          action: 'push.subscribe',
          entity: 'member',
          entityId: req.user!.id,
        });
    });
    return { ok: true };
  });

  app.post(
    '/push/unsubscribe',
    { schema: { body: z.object({ endpoint: z.string().max(1000) }) } },
    async (req) => {
      await db.transaction(async (tx) => {
        const removed = await tx
          .delete(pushSubscription)
          .where(
            and(
              eq(pushSubscription.endpoint, req.body.endpoint),
              eq(pushSubscription.memberId, req.user!.id),
            ),
          )
          .returning({ id: pushSubscription.id });
        if (removed.length)
          await audit(tx, req, {
            action: 'push.unsubscribe',
            entity: 'member',
            entityId: req.user!.id,
          });
      });
      return { ok: true };
    },
  );
};
