import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pushSubscription, type Db } from '@episoft/db';
import type { Config } from '../../config';
import { pushEnabled } from '../../lib/push';

const subscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
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
    await db
      .insert(pushSubscription)
      .values({ memberId: req.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: { memberId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth },
      });
    return { ok: true };
  });

  app.post(
    '/push/unsubscribe',
    { schema: { body: z.object({ endpoint: z.string().max(1000) }) } },
    async (req) => {
      await db
        .delete(pushSubscription)
        .where(
          and(
            eq(pushSubscription.endpoint, req.body.endpoint),
            eq(pushSubscription.memberId, req.user!.id),
          ),
        );
      return { ok: true };
    },
  );
};
