import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { product, productFavorite, type Db } from '@episoft/db';
import type { Config } from '../../config';
import { notFound } from '../../lib/problem';

const idParams = z.object({ id: z.string().uuid() });

/** A member's favourite products of the shop; private to them. */
export const favoriteRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  app.get('/shop/favorites', async (req) => {
    const rows = await db
      .select({ id: productFavorite.productId })
      .from(productFavorite)
      .where(eq(productFavorite.memberId, req.user!.id));
    return rows.map((r) => r.id);
  });

  app.put('/shop/favorites/:id', { schema: { params: idParams } }, async (req) => {
    const [p] = await db
      .select({ id: product.id })
      .from(product)
      .where(eq(product.id, req.params.id));
    if (!p) throw notFound('Produit introuvable.');
    await db
      .insert(productFavorite)
      .values({ memberId: req.user!.id, productId: p.id })
      .onConflictDoNothing();
    return { ok: true };
  });

  app.delete('/shop/favorites/:id', { schema: { params: idParams } }, async (req) => {
    await db
      .delete(productFavorite)
      .where(
        and(
          eq(productFavorite.memberId, req.user!.id),
          eq(productFavorite.productId, req.params.id),
        ),
      );
    return { ok: true };
  });
};
