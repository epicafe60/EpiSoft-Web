import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { product, productFavorite, type Db } from '@episoft/db';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/problem';
import { shopOpen } from '../../lib/shop-gate';

const idParams = z.object({ id: z.string().uuid() });

/** A member's favourite products of the shop; private to them. */
export const favoriteRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  app.get('/shop/favorites', { preHandler: shopOpen(db) }, async (req) => {
    const rows = await db
      .select({ id: productFavorite.productId })
      .from(productFavorite)
      .where(eq(productFavorite.memberId, req.user!.id));
    return rows.map((r) => r.id);
  });

  app.put(
    '/shop/favorites/:id',
    { preHandler: shopOpen(db), schema: { params: idParams } },
    async (req) => {
      const [p] = await db
        .select({ id: product.id })
        .from(product)
        .where(eq(product.id, req.params.id));
      if (!p) throw notFound('Produit introuvable.');
      await db.transaction(async (tx) => {
        const added = await tx
          .insert(productFavorite)
          .values({ memberId: req.user!.id, productId: p.id })
          .onConflictDoNothing()
          .returning({ productId: productFavorite.productId });
        if (added.length)
          await audit(tx, req, { action: 'favorite.add', entity: 'product', entityId: p.id });
      });
      return { ok: true };
    },
  );

  app.delete(
    '/shop/favorites/:id',
    { preHandler: shopOpen(db), schema: { params: idParams } },
    async (req) => {
      await db.transaction(async (tx) => {
        const removed = await tx
          .delete(productFavorite)
          .where(
            and(
              eq(productFavorite.memberId, req.user!.id),
              eq(productFavorite.productId, req.params.id),
            ),
          )
          .returning({ productId: productFavorite.productId });
        if (removed.length)
          await audit(tx, req, {
            action: 'favorite.remove',
            entity: 'product',
            entityId: req.params.id,
          });
      });
      return { ok: true };
    },
  );
};
