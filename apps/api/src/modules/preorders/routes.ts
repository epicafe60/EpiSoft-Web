import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  category,
  member,
  preorder,
  preorderLine,
  product,
  type Db,
  type DbOrTx,
} from '@episoft/db';
import {
  OPEN_PREORDER_STATUSES,
  PREORDER_STATUSES,
  canTransition,
  decimalToCents,
  formatDocNumber,
  hasAnyRole,
  memberCanCancel,
  mergeCartLines,
  parseQtyToMilli,
  pickupDateValid,
  preorderSchema,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toParisDate } from '../../lib/dates';
import { badRequest, conflict, forbidden, notFound } from '../../lib/problem';
import { nextNumber } from '../pos/numbers';

const idParams = { params: z.object({ id: z.string().uuid() }) };

/** R-PRE-02: quantities still asked by open pre-orders, per product, in thousandths. */
export async function reservedByProduct(
  db: DbOrTx,
  productIds: readonly string[],
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({
      productId: preorderLine.productId,
      qty: sql<string>`sum(${preorderLine.qty})::text`,
    })
    .from(preorderLine)
    .innerJoin(preorder, eq(preorder.id, preorderLine.preorderId))
    .where(
      and(
        inArray(preorder.status, [...OPEN_PREORDER_STATUSES]),
        inArray(preorderLine.productId, [...productIds]),
      ),
    )
    .groupBy(preorderLine.productId);
  return new Map(rows.map((r) => [r.productId, parseQtyToMilli(r.qty) ?? 0]));
}

/** Products a customer can put in the cart: sold on order, active, goods. */
const ORDERABLE = and(
  inArray(product.status, ['ACTIVE', 'ON_ORDER']),
  inArray(product.saleCondition, ['ON_ORDER', 'BOTH']),
  eq(product.kind, 'GOODS'),
);

async function detail(db: DbOrTx, id: string) {
  const o = await db.query.preorder.findFirst({ where: eq(preorder.id, id) });
  if (!o) return null;
  const [lines, who] = await Promise.all([
    db
      .select()
      .from(preorderLine)
      .where(eq(preorderLine.preorderId, id))
      .orderBy(asc(preorderLine.lineNo)),
    db.query.member.findFirst({ where: eq(member.id, o.memberId) }),
  ]);
  const totalCents = lines.reduce(
    (s, l) => s + Math.round(((parseQtyToMilli(l.qty) ?? 0) * decimalToCents(l.unitPrice)) / 1000),
    0,
  );
  return {
    ...o,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    memberName: who ? `${who.lastName} ${who.firstName}` : '',
    totalCents,
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      label: l.label,
      qty: l.qty,
      unitPrice: l.unitPrice,
    })),
  };
}

export const preorderRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const staff = {
    preHandler: app.requireRoles('COMMANDES_GESTION', 'COMMANDES_EN_LIGNE', 'CAISSE'),
  };
  // The till reads the open orders to hand them over (R-PRE-03).
  const canRead = (roles: Parameters<typeof hasAnyRole>[0]) =>
    hasAnyRole(roles, ['COMMANDES_EN_LIGNE', 'COMMANDES_GESTION', 'CAISSE']);
  const canOrderFor = (roles: Parameters<typeof hasAnyRole>[0]) =>
    hasAnyRole(roles, ['COMMANDES_EN_LIGNE', 'COMMANDES_GESTION']);

  /** The shop window: what a customer can put in the cart (any signed-in member). */
  app.get(
    '/shop/products',
    {
      schema: {
        querystring: z.object({
          q: z.string().trim().max(60).optional(),
          categoryId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const { q, categoryId } = req.query;
      const like = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      return db
        .select({
          id: product.id,
          name: product.name,
          description: product.description,
          salePrice: product.salePrice,
          saleMode: product.saleMode,
          unit: product.unit,
          categoryId: product.categoryId,
          categoryName: category.name,
          imageId: product.imageId,
        })
        .from(product)
        .leftJoin(category, eq(category.id, product.categoryId))
        .where(
          and(
            ORDERABLE,
            categoryId ? eq(product.categoryId, categoryId) : undefined,
            like ? sql`${product.name} ilike ${like}` : undefined,
          ),
        )
        .orderBy(asc(category.name), asc(product.name))
        .limit(500);
    },
  );

  /** R-PRE-01: the signed-in member orders for themselves; a volunteer may order for a member. */
  app.post('/preorders', { schema: { body: preorderSchema } }, async (req) => {
    const b = req.body;
    const user = req.user!;
    if (b.memberId && b.memberId !== user.id && !canOrderFor(user.roles)) throw forbidden();
    const today = toParisDate(new Date());
    if (!pickupDateValid(b.pickupDate, today))
      throw badRequest('La date de retrait ne peut pas être passée.');
    return db.transaction(async (tx) => {
      const owner = await tx.query.member.findFirst({
        where: eq(member.id, b.memberId ?? user.id),
      });
      if (!owner) throw notFound('Membre introuvable.');
      const lines = mergeCartLines(b.lines);
      const products = await tx
        .select()
        .from(product)
        .where(
          and(
            ORDERABLE,
            inArray(
              product.id,
              lines.map((l) => l.productId),
            ),
          ),
        );
      const byId = new Map(products.map((p) => [p.id, p]));
      if (lines.some((l) => !byId.has(l.productId)))
        throw badRequest('Certains produits ne sont plus disponibles à la commande.');
      const year = Number(today.slice(0, 4));
      const number = formatDocNumber('PC', year, await nextNumber(tx, `preorder:${year}`));
      const [o] = await tx
        .insert(preorder)
        .values({
          number,
          memberId: owner.id,
          householdId: owner.householdId,
          pickupDate: b.pickupDate,
          comment: b.comment || null,
          createdBy: user.id,
        })
        .returning();
      await tx.insert(preorderLine).values(
        lines.map((l, i) => {
          const p = byId.get(l.productId)!;
          return {
            preorderId: o!.id,
            lineNo: i + 1,
            productId: p.id,
            label: p.name,
            qty: l.qty,
            unitPrice: p.salePrice,
          };
        }),
      );
      await audit(tx, req, {
        action: 'preorder.create',
        entity: 'preorder',
        entityId: o!.id,
        after: { number, member: owner.number, lines: lines.length },
      });
      return { id: o!.id, number };
    });
  });

  app.get('/preorders/mine', async (req) => {
    const rows = await db
      .select({ id: preorder.id })
      .from(preorder)
      .where(eq(preorder.memberId, req.user!.id))
      .orderBy(desc(preorder.createdAt))
      .limit(50);
    return Promise.all(rows.map((r) => detail(db, r.id)));
  });

  /** Staff list: open orders by pick-up date first. */
  app.get(
    '/preorders',
    {
      ...staff,
      schema: {
        querystring: z.object({
          status: z.enum(PREORDER_STATUSES).optional(),
          open: z.enum(['true']).optional(),
        }),
      },
    },
    async (req) => {
      const { status, open } = req.query;
      const rows = await db
        .select({
          id: preorder.id,
          number: preorder.number,
          status: preorder.status,
          pickupDate: preorder.pickupDate,
          createdAt: preorder.createdAt,
          memberNumber: member.number,
          memberName: sql<string>`${member.lastName} || ' ' || ${member.firstName}`,
          lineCount: sql<number>`(select count(*)::int from app.preorder_line l where l.preorder_id = ${preorder.id})`,
          total: sql<string>`(select coalesce(sum(round(l.qty * l.unit_price, 2)), 0)::text from app.preorder_line l where l.preorder_id = ${preorder.id})`,
        })
        .from(preorder)
        .innerJoin(member, eq(member.id, preorder.memberId))
        .where(
          and(
            status ? eq(preorder.status, status) : undefined,
            open ? inArray(preorder.status, [...OPEN_PREORDER_STATUSES]) : undefined,
          ),
        )
        .orderBy(asc(preorder.pickupDate), asc(preorder.number))
        .limit(500);
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    },
  );

  app.get('/preorders/:id', { schema: idParams }, async (req) => {
    const o = await detail(db, req.params.id);
    const user = req.user!;
    if (!o || (o.memberId !== user.id && !canRead(user.roles)))
      throw notFound('Précommande introuvable.');
    return o;
  });

  /** Staff prepare or cancel; the member may cancel their own while it is only received. */
  app.post(
    '/preorders/:id/status',
    { schema: { ...idParams, body: z.object({ status: z.enum(PREORDER_STATUSES) }) } },
    async (req) =>
      db.transaction(async (tx) => {
        const [o] = await tx
          .select()
          .from(preorder)
          .where(eq(preorder.id, req.params.id))
          .for('update');
        const user = req.user!;
        if (!o) throw notFound('Précommande introuvable.');
        const to = req.body.status;
        const isManager = hasAnyRole(user.roles, ['COMMANDES_GESTION']);
        const ownCancel = o.memberId === user.id && to === 'CANCELLED' && memberCanCancel(o.status);
        if (!isManager && !ownCancel) throw forbidden();
        // The pick-up goes through the till (R-PRE-03); only an ADMIN closes an order by hand.
        const adminClose = to === 'PICKED_UP' && hasAnyRole(user.roles, ['ADMIN']);
        if (to === 'PICKED_UP' && !adminClose)
          throw badRequest('Une précommande est retirée depuis la caisse.');
        const allowed = adminClose
          ? (OPEN_PREORDER_STATUSES as readonly string[]).includes(o.status)
          : canTransition(o.status, to);
        if (!allowed) throw conflict('Ce changement d’état n’est pas possible.');
        await tx
          .update(preorder)
          .set({ status: to, updatedAt: new Date() })
          .where(eq(preorder.id, o.id));
        await audit(tx, req, {
          action: 'preorder.status',
          entity: 'preorder',
          entityId: o.id,
          before: { status: o.status },
          after: { status: to },
        });
        return { ok: true };
      }),
  );
};
