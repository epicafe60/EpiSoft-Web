import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  goodsReceipt,
  member,
  product,
  productLot,
  sale,
  saleLine,
  stockMovement,
  supplier,
  type Db,
  type DbOrTx,
} from '@episoft/db';
import {
  allocateFefo,
  milliToDecimal,
  parseQtyToMilli,
  receiptLotProblem,
  type FefoLot,
  type FefoOut,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toShopDate } from '../../lib/dates';
import { badRequest, notFound } from '../../lib/problem';

const idParams = { params: z.object({ id: z.string().uuid() }) };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide.');

/**
 * The method behind every figure below, shown with them: the till records what is sold, not the
 * lot it was taken from, so the sales of a lot are estimated first expired, first out (FEFO).
 */
export const FEFO_NOTE =
  'Estimation « premier périmé, premier sorti » : la caisse n’enregistre pas le lot de chaque article vendu. ' +
  'Les sorties de stock (ventes, pertes, retours fournisseur) sont rejouées dans l’ordre du temps et prélevées sur ' +
  'les lots déjà reçus, à date limite la plus proche d’abord. Le résultat est exact si le rayon est servi ainsi ; ' +
  'sinon il désigne les clients qui ont pu recevoir le lot. Une sortie sans lot connu (stock antérieur à la saisie des lots) ' +
  'est signalée à part.';

interface OutDetail extends FefoOut {
  kind: string;
  saleId: string | null;
}

/** Every lot of a product and every exit of its stock, with what FEFO says of them. */
async function replayProduct(db: DbOrTx, productId: string) {
  const lotRows = await db
    .select()
    .from(productLot)
    .where(eq(productLot.productId, productId));
  const lots: FefoLot[] = lotRows.map((l) => ({
    id: l.id,
    receivedOn: l.receivedOn,
    bestBefore: l.bestBefore,
    qtyMilli: parseQtyToMilli(l.qty)!,
  }));
  const moves = await db
    .select()
    .from(stockMovement)
    .where(and(eq(stockMovement.productId, productId), sql`${stockMovement.qty} < 0`));
  const saleIds = moves
    .filter((m) => m.sourceType === 'sale' && m.sourceId)
    .map((m) => m.sourceId!);
  const sales = saleIds.length
    ? await db
        .select({ id: sale.id, status: sale.status })
        .from(sale)
        .where(inArray(sale.id, saleIds))
    : [];
  const cancelled = new Set(sales.filter((s) => s.status === 'CANCELLED').map((s) => s.id));
  const outs: OutDetail[] = [];
  for (const m of moves) {
    // A cancelled ticket gave nothing out (its goods came back): it is not an exit.
    if (m.kind === 'SALE' && m.sourceId && cancelled.has(m.sourceId)) continue;
    // Only goods leaving are replayed (a negative reception or opening balance is not an exit).
    if (m.kind === 'INITIAL' || m.kind === 'PURCHASE_IN') continue;
    outs.push({
      id: m.id,
      day: toShopDate(m.at),
      at: m.at.toISOString(),
      qtyMilli: -parseQtyToMilli(m.qty)!,
      kind: m.kind,
      saleId: m.kind === 'SALE' && m.sourceType === 'sale' ? m.sourceId : null,
    });
  }
  return { lotRows, lots, outs, result: allocateFefo(lots, outs) };
}

async function customerOf(db: DbOrTx, saleIds: string[]) {
  if (!saleIds.length) return new Map<string, SaleInfo>();
  const rows = await db
    .select({
      id: sale.id,
      number: sale.number,
      soldAt: sale.soldAt,
      memberId: sale.memberId,
      mNumber: member.number,
      lastName: member.lastName,
      firstName: member.firstName,
      email: member.email,
      phone: member.phone,
      householdId: member.householdId,
    })
    .from(sale)
    .leftJoin(member, eq(member.id, sale.memberId))
    .where(inArray(sale.id, saleIds));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        number: r.number,
        soldAt: r.soldAt.toISOString(),
        member: r.memberId
          ? {
              id: r.memberId,
              number: r.mNumber!,
              name: `${r.lastName} ${r.firstName}`.trim(),
              email: r.email,
              phone: r.phone,
              householdId: r.householdId,
            }
          : null,
      },
    ]),
  );
}

interface SaleInfo {
  id: string;
  number: string;
  soldAt: string;
  member: {
    id: string;
    number: number;
    name: string;
    email: string | null;
    phone: string | null;
    householdId: string | null;
  } | null;
}

/** Who may have received a lot: the tickets that took from it, per identified member. */
async function lotReport(db: DbOrTx, lotId: string) {
  const [lot] = await db
    .select({
      id: productLot.id,
      productId: productLot.productId,
      code: product.code,
      name: product.name,
      unit: product.unit,
      supplierId: productLot.supplierId,
      supplierName: supplier.name,
      supplierCode: supplier.code,
      receiptId: productLot.receiptId,
      receiptNumber: goodsReceipt.number,
      lotNumber: productLot.lotNumber,
      bestBefore: productLot.bestBefore,
      qty: productLot.qty,
      receivedOn: productLot.receivedOn,
    })
    .from(productLot)
    .innerJoin(product, eq(product.id, productLot.productId))
    .leftJoin(supplier, eq(supplier.id, productLot.supplierId))
    .leftJoin(goodsReceipt, eq(goodsReceipt.id, productLot.receiptId))
    .where(eq(productLot.id, lotId));
  if (!lot) throw notFound('Lot introuvable.');
  const replay = await replayProduct(db, lot.productId);
  const mine = replay.result.allocations.filter((a) => a.lotId === lot.id);
  const outById = new Map(replay.outs.map((o) => [o.id, o]));
  const saleIds = [
    ...new Set(mine.map((a) => outById.get(a.outId)!.saleId).filter((x): x is string => !!x)),
  ];
  const customers = await customerOf(db, saleIds);
  let soldMilli = 0;
  let otherMilli = 0;
  const tickets: {
    saleId: string;
    number: string;
    soldAt: string;
    qty: string;
    member: SaleInfo['member'];
  }[] = [];
  const otherExits: { at: string; kind: string; qty: string }[] = [];
  for (const a of mine) {
    const out = outById.get(a.outId)!;
    if (out.saleId) {
      soldMilli += a.qtyMilli;
      const c = customers.get(out.saleId);
      tickets.push({
        saleId: out.saleId,
        number: c?.number ?? '?',
        soldAt: c?.soldAt ?? out.at,
        qty: milliToDecimal(a.qtyMilli),
        member: c?.member ?? null,
      });
    } else {
      otherMilli += a.qtyMilli;
      otherExits.push({ at: out.at, kind: out.kind, qty: milliToDecimal(a.qtyMilli) });
    }
  }
  tickets.sort((a, b) => (a.soldAt < b.soldAt ? -1 : 1));
  return {
    lot,
    soldQty: milliToDecimal(soldMilli),
    otherExitsQty: milliToDecimal(otherMilli),
    remainingQty: milliToDecimal(replay.result.remaining.get(lot.id) ?? 0),
    tickets,
    otherExits,
    unexplainedExits: replay.result.unallocated.length,
    method: 'FEFO' as const,
    note: FEFO_NOTE,
  };
}

export const traceabilityRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const readers = { preHandler: app.requireRoles('APPROS', 'PRODUITS') };
  const writers = { preHandler: app.requireRoles('APPROS') };

  /** The lots received, most recent first; searched by lot number, product or supplier. */
  app.get(
    '/traceability/lots',
    {
      ...readers,
      schema: {
        querystring: z.object({
          q: z.string().max(100).optional(),
          productId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req) => {
      const q = req.query.q?.trim();
      const rows = await db
        .select({
          id: productLot.id,
          productId: product.id,
          code: product.code,
          name: product.name,
          supplierName: supplier.name,
          receiptNumber: goodsReceipt.number,
          lotNumber: productLot.lotNumber,
          bestBefore: productLot.bestBefore,
          qty: productLot.qty,
          receivedOn: productLot.receivedOn,
        })
        .from(productLot)
        .innerJoin(product, eq(product.id, productLot.productId))
        .leftJoin(supplier, eq(supplier.id, productLot.supplierId))
        .leftJoin(goodsReceipt, eq(goodsReceipt.id, productLot.receiptId))
        .where(
          and(
            req.query.productId ? eq(productLot.productId, req.query.productId) : undefined,
            q
              ? or(
                  ilike(productLot.lotNumber, `%${q}%`),
                  ilike(product.name, `%${q}%`),
                  eq(product.code, q),
                  ilike(supplier.name, `%${q}%`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(productLot.receivedOn), desc(productLot.createdAt))
        .limit(req.query.limit);
      return rows;
    },
  );

  /** A lot recorded outside a receipt (stock that was already there). */
  app.post(
    '/traceability/lots',
    {
      ...writers,
      schema: {
        body: z.object({
          productId: z.string().uuid(),
          supplierId: z.string().uuid().nullable().default(null),
          lotNumber: z.string().trim().max(60),
          bestBefore: isoDate.nullable().default(null),
          qty: z
            .string()
            .trim()
            .refine((s) => (parseQtyToMilli(s) ?? 0) > 0, 'Quantité positive attendue.'),
          receivedOn: isoDate.optional(),
        }),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const b = req.body;
        const [p] = await tx.select().from(product).where(eq(product.id, b.productId));
        if (!p) throw notFound('Produit introuvable.');
        if (p.kind !== 'GOODS') throw badRequest('Un service n’a pas de lot.');
        const problem = receiptLotProblem(p, { lotNumber: b.lotNumber, bestBefore: b.bestBefore });
        if (problem) throw badRequest(problem);
        if (!p.isFood) {
          // Not food: a lot number is optional, but when typed it must be a real one.
          if (b.lotNumber.length < 2) throw badRequest('Numéro de lot obligatoire.');
        }
        if (b.supplierId) {
          const [s] = await tx.select({ id: supplier.id }).from(supplier).where(eq(supplier.id, b.supplierId));
          if (!s) throw badRequest('Fournisseur inconnu.');
        }
        const [lot] = await tx
          .insert(productLot)
          .values({
            productId: p.id,
            supplierId: b.supplierId ?? p.supplierId,
            lotNumber: b.lotNumber,
            bestBefore: b.bestBefore,
            qty: milliToDecimal(parseQtyToMilli(b.qty)!),
            receivedOn: b.receivedOn ?? toShopDate(new Date()),
            by: req.user!.id,
          })
          .returning();
        await audit(tx, req, {
          action: 'lot.create',
          entity: 'product',
          entityId: p.id,
          after: { lotNumber: lot!.lotNumber, bestBefore: lot!.bestBefore, qty: lot!.qty },
        });
        return { id: lot!.id };
      }),
  );

  /** From a lot: its receipt and supplier, what was taken from it and by which tickets. */
  app.get('/traceability/lots/:id', { ...readers, schema: idParams }, async (req) =>
    lotReport(db, req.params.id),
  );

  /**
   * Recall helper: the members to warn about a lot, with their e-mail (and phone when there is no
   * e-mail), the tickets concerned, and what was sold to people who cannot be warned by name.
   * Viewing it is recorded: it lists personal data.
   */
  app.get('/traceability/lots/:id/recall', { ...readers, schema: idParams }, async (req) => {
    const report = await lotReport(db, req.params.id);
    const byMember = new Map<
      string,
      { member: NonNullable<SaleInfo['member']>; tickets: { number: string; soldAt: string; qty: string }[] }
    >();
    let anonymousMilli = 0;
    let anonymousTickets = 0;
    for (const t of report.tickets) {
      if (!t.member) {
        anonymousMilli += parseQtyToMilli(t.qty)!;
        anonymousTickets++;
        continue;
      }
      const e = byMember.get(t.member.id) ?? { member: t.member, tickets: [] };
      e.tickets.push({ number: t.number, soldAt: t.soldAt, qty: t.qty });
      byMember.set(t.member.id, e);
    }
    const members = [...byMember.values()].sort((a, b) =>
      a.member.name.localeCompare(b.member.name, 'fr'),
    );
    const withEmail = members.filter((m) => m.member.email);
    await db.transaction((tx) =>
      audit(tx, req, {
        action: 'lot.recall_view',
        entity: 'product',
        entityId: report.lot.productId,
        after: {
          lotNumber: report.lot.lotNumber,
          members: members.length,
          withEmail: withEmail.length,
        },
      }),
    );
    return {
      lot: report.lot,
      soldQty: report.soldQty,
      members: members.map((m) => ({ ...m.member, tickets: m.tickets })),
      emails: [...new Set(withEmail.map((m) => m.member.email!))],
      withoutEmail: members.filter((m) => !m.member.email).map((m) => m.member.id),
      anonymousTickets,
      anonymousQty: milliToDecimal(anonymousMilli),
      note: FEFO_NOTE,
      advice:
        'Prévenez aussi les clients de passage par un affichage en caisse : leurs achats ne sont pas rattachés à un nom. ' +
        'En cas de produit dangereux, informez la DDPP (direction départementale de la protection des populations).',
    };
  });

  /** From a sale (its number or id): the lot(s) each line may come from. */
  app.get(
    '/traceability/sales/:ref',
    { ...readers, schema: { params: z.object({ ref: z.string().min(1).max(60) }) } },
    async (req) => {
      const ref = req.params.ref.trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
      const [s] = await db
        .select()
        .from(sale)
        .where(isUuid ? eq(sale.id, ref) : eq(sale.number, ref));
      if (!s) throw notFound('Ticket introuvable.');
      const lines = await db
        .select({
          productId: saleLine.productId,
          code: product.code,
          name: product.name,
          isFood: product.isFood,
          qty: saleLine.qty,
        })
        .from(saleLine)
        .innerJoin(product, eq(product.id, saleLine.productId))
        .where(eq(saleLine.saleId, s.id))
        .orderBy(saleLine.lineNo);
      const out = [];
      for (const productId of [...new Set(lines.map((l) => l.productId))]) {
        const replay = await replayProduct(db, productId);
        const mine = replay.outs.find((o) => o.saleId === s.id);
        const l = lines.find((x) => x.productId === productId)!;
        const lotInfo = new Map(replay.lotRows.map((r) => [r.id, r]));
        const allocations = mine
          ? replay.result.allocations.filter((a) => a.outId === mine.id)
          : [];
        const unexplained = mine
          ? (replay.result.unallocated.find((u) => u.outId === mine.id)?.qtyMilli ?? 0)
          : 0;
        out.push({
          productId,
          code: l.code,
          name: l.name,
          isFood: l.isFood,
          qtyMilli: lines
            .filter((x) => x.productId === productId)
            .reduce((n, x) => n + parseQtyToMilli(x.qty)!, 0),
          lots: allocations.map((a) => {
            const r = lotInfo.get(a.lotId)!;
            return {
              lotId: r.id,
              lotNumber: r.lotNumber,
              bestBefore: r.bestBefore,
              receivedOn: r.receivedOn,
              qty: milliToDecimal(a.qtyMilli),
            };
          }),
          unexplainedQty: milliToDecimal(unexplained),
        });
      }
      return {
        sale: { id: s.id, number: s.number, soldAt: s.soldAt.toISOString() },
        lines: out.map(({ qtyMilli, ...l }) => ({ ...l, qty: milliToDecimal(qtyMilli) })),
        method: 'FEFO' as const,
        note: FEFO_NOTE,
      };
    },
  );
};
