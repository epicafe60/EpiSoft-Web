import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { member, product, productReview, type Db } from '@episoft/db';
import { ratingSummary, reviewAuthor, reviewSchema } from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/problem';
import { shopOpen } from '../../lib/shop-gate';

const idParams = z.object({ id: z.string().uuid() });

/** Customer reviews: any member rates, PRODUITS moderates, only approved ones are public. */
export const reviewRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const moderators = { preHandler: app.requireRoles('PRODUITS') };

  /** Average rating and count per product, approved reviews only. */
  app.get('/shop/ratings', { preHandler: shopOpen(db) }, async () => {
    const res = await db.execute(sql`
      select product_id, round(avg(rating)::numeric, 1)::float as average, count(*)::int as count
      from app.product_review where status = 'APPROVED' group by 1`);
    return Object.fromEntries(
      (res.rows as { product_id: string; average: number; count: number }[]).map((r) => [
        r.product_id,
        { average: Number(r.average), count: Number(r.count) },
      ]),
    );
  });

  app.get(
    '/shop/products/:id/reviews',
    { preHandler: shopOpen(db), schema: { params: idParams } },
    async (req) => {
      const me = req.user!.id;
      const rows = await db
        .select({
          id: productReview.id,
          rating: productReview.rating,
          comment: productReview.comment,
          status: productReview.status,
          createdAt: productReview.createdAt,
          memberId: productReview.memberId,
          firstName: member.firstName,
          lastName: member.lastName,
        })
        .from(productReview)
        .innerJoin(member, eq(member.id, productReview.memberId))
        .where(
          and(
            eq(productReview.productId, req.params.id),
            or(eq(productReview.status, 'APPROVED'), eq(productReview.memberId, me)),
          ),
        )
        .orderBy(desc(productReview.createdAt));
      const published = rows.filter((r) => r.status === 'APPROVED');
      return {
        ...ratingSummary(published.map((r) => r.rating)),
        reviews: rows.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          author: reviewAuthor(r.firstName, r.lastName),
          mine: r.memberId === me,
        })),
      };
    },
  );

  /** One review per member and product; editing it sends it back to moderation. */
  app.put(
    '/shop/products/:id/review',
    { preHandler: shopOpen(db), schema: { params: idParams, body: reviewSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [p] = await tx
          .select({ id: product.id })
          .from(product)
          .where(eq(product.id, req.params.id));
        if (!p) throw notFound('Produit introuvable.');
        const values = {
          productId: p.id,
          memberId: req.user!.id,
          rating: req.body.rating,
          comment: req.body.comment,
          status: 'PENDING',
        };
        await tx
          .insert(productReview)
          .values(values)
          .onConflictDoUpdate({
            target: [productReview.productId, productReview.memberId],
            set: {
              rating: values.rating,
              comment: values.comment,
              status: 'PENDING',
              updatedAt: sql`now()`,
            },
          });
        return { ok: true };
      }),
  );

  app.get('/reviews/pending', moderators, async () =>
    db
      .select({
        id: productReview.id,
        rating: productReview.rating,
        comment: productReview.comment,
        createdAt: productReview.createdAt,
        productName: product.name,
        firstName: member.firstName,
        lastName: member.lastName,
      })
      .from(productReview)
      .innerJoin(product, eq(product.id, productReview.productId))
      .innerJoin(member, eq(member.id, productReview.memberId))
      .where(eq(productReview.status, 'PENDING'))
      .orderBy(productReview.createdAt),
  );

  app.post(
    '/reviews/:id/moderate',
    {
      ...moderators,
      schema: { params: idParams, body: z.object({ status: z.enum(['APPROVED', 'HIDDEN']) }) },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const [r] = await tx
          .update(productReview)
          .set({ status: req.body.status, updatedAt: sql`now()` })
          .where(eq(productReview.id, req.params.id))
          .returning();
        if (!r) throw notFound('Avis introuvable.');
        await audit(tx, req, {
          action: 'review.moderate',
          entity: 'product_review',
          entityId: r.id,
          after: { status: r.status },
        });
        return { ok: true };
      }),
  );
};
