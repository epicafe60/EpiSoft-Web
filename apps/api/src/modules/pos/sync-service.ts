import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  cashSession,
  household,
  member,
  memberPayment,
  membership,
  membershipType,
  posDevice,
  product,
  sale,
  saleLine,
  salePayment,
  stockMovement,
  syncReceipt,
  userRole,
  walletEntry,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  centsToDecimal,
  decimalToCents,
  hasAnyRole,
  lineTotalCents,
  membershipPeriod,
  milliToDecimal,
  parseQtyToMilli,
  walletPaymentAllowed,
  type PaymentMethod,
  type SyncOp,
  type SyncResult,
  type SyncWarning,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toParisDate } from '../../lib/dates';
import { queueEmail } from '../../lib/mail';
import { saleReceiptEmail, topupReceiptEmail } from '../../lib/receipts';
import { loadSettings } from '../admin/settings-store';
import { nextSaleNumber } from './numbers';
import { currentMembershipEnd, lockedBalanceCents } from './wallet';

/** A business rule refused the operation; it is answered REJECTED, not as an error. */
export class Rejected extends Error {}

interface Ctx {
  tx: Tx;
  req: FastifyRequest;
  config: Config;
  deviceId: string;
  warnings: SyncWarning[];
}

const warn = (ctx: Ctx, code: string, message: string) => ctx.warnings.push({ code, message });

/**
 * Processes the operations of one device in order (R-SYNC-03). Each operation has its own
 * transaction; a replayed operation returns the stored result (R-SYNC-02).
 */
export async function processOps(
  db: Db,
  req: FastifyRequest,
  config: Config,
  deviceId: string,
  ops: SyncOp[],
): Promise<SyncResult[]> {
  const device = await db.query.posDevice.findFirst({ where: eq(posDevice.id, deviceId) });
  if (!device || !device.active) throw new Rejected('Poste de caisse inconnu ou désactivé.');

  const results: SyncResult[] = [];
  for (const op of [...ops].sort((a, b) => a.deviceSeq - b.deviceSeq)) {
    results.push(await processOne(db, req, config, deviceId, op));
  }
  await db.update(posDevice).set({ lastSyncAt: new Date() }).where(eq(posDevice.id, deviceId));
  return results;
}

async function processOne(
  db: Db,
  req: FastifyRequest,
  config: Config,
  deviceId: string,
  op: SyncOp,
): Promise<SyncResult> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'op:' + op.id}))`);
      const done = await tx.query.syncReceipt.findFirst({ where: eq(syncReceipt.clientId, op.id) });
      if (done) return done.result as SyncResult;

      const ctx: Ctx = { tx, req, config, deviceId, warnings: [] };
      let result: SyncResult;
      try {
        // Savepoint: a rejection undoes the partial work but keeps the receipt below.
        result = await tx.transaction(async (sp) => {
          const inner = { ...ctx, tx: sp };
          const number = await dispatch(inner, op);
          return {
            id: op.id,
            status: 'OK' as const,
            warnings: ctx.warnings,
            ...(number ? { number } : {}),
          };
        });
      } catch (e) {
        if (!(e instanceof Rejected)) throw e;
        result = { id: op.id, status: 'REJECTED', warnings: ctx.warnings, error: e.message };
      }
      await tx.insert(syncReceipt).values({ clientId: op.id, deviceId, kind: op.kind, result });
      return result;
    });
  } catch (e) {
    req.log.error({ err: e, op: op.id, kind: op.kind }, 'échec de traitement d’une opération');
    // Not recorded: the device retries later (R-OFF-03).
    throw e;
  }
}

async function dispatch(ctx: Ctx, op: SyncOp): Promise<string | undefined> {
  switch (op.kind) {
    case 'SESSION_OPEN':
      await openSession(ctx, op.payload);
      return undefined;
    case 'SALE':
      // The sale id is the operation id, generated on the device (§6.2: idempotency key).
      return recordSale(ctx, op.payload, op.deviceSeq, op.id);
    case 'SALE_CANCEL':
      return cancelSale(ctx, op.payload, op.deviceSeq);
    case 'WALLET_TOPUP':
      await topup(ctx, op.payload);
      return undefined;
  }
}

// --- Session ------------------------------------------------------------------------

async function openSession(ctx: Ctx, p: Extract<SyncOp, { kind: 'SESSION_OPEN' }>['payload']) {
  const open = await ctx.tx.query.cashSession.findFirst({
    where: and(eq(cashSession.deviceId, ctx.deviceId), eq(cashSession.status, 'OPEN')),
  });
  if (open && open.id !== p.sessionId) {
    throw new Rejected('Une autre session est déjà ouverte sur ce poste. Clôturez-la d’abord.');
  }
  if (open) return;
  await ctx.tx.insert(cashSession).values({
    id: p.sessionId,
    deviceId: ctx.deviceId,
    openedBy: p.openedBy,
    openedAt: new Date(p.openedAt),
    openingFloat: p.openingFloat,
  });
  await audit(ctx.tx, ctx.req, {
    action: 'session.open',
    entity: 'cash_session',
    entityId: p.sessionId,
    after: { openingFloat: p.openingFloat },
  });
}

async function sessionOf(ctx: Ctx, sessionId: string) {
  const s = await ctx.tx.query.cashSession.findFirst({
    where: and(eq(cashSession.id, sessionId), eq(cashSession.deviceId, ctx.deviceId)),
  });
  if (!s) throw new Rejected('Session de caisse inconnue pour ce poste.');
  if (s.status === 'CLOSED')
    warn(ctx, 'SESSION_CLOSED', 'La session était déjà clôturée (clôture forcée).');
  return s;
}

async function checkCashier(ctx: Ctx, cashierId: string) {
  const roles = await ctx.tx
    .select({ code: userRole.roleCode })
    .from(userRole)
    .where(eq(userRole.memberId, cashierId));
  if (!roles.some((r) => r.code === 'CAISSE')) {
    warn(ctx, 'CASHIER_ROLE', 'Le caissier indiqué n’a pas le rôle Caisse.');
  }
}

// --- Sale (R-VTE-10) ----------------------------------------------------------------

type SalePayload = Extract<SyncOp, { kind: 'SALE' }>['payload'];

async function recordSale(
  ctx: Ctx,
  p: SalePayload,
  deviceSeq: number,
  saleId: string,
): Promise<string> {
  const { tx } = ctx;
  const session = await sessionOf(ctx, p.sessionId);
  await checkCashier(ctx, p.cashierId);
  const soldAt = new Date(p.soldAt);

  // Products. A product deactivated in the meantime is still accepted (R-SYNC-04).
  const productIds = [...new Set(p.lines.map((l) => l.productId))];
  const products = await tx.select().from(product).where(inArray(product.id, productIds));
  const byId = new Map(products.map((x) => [x.id, x]));
  const types = await tx
    .select()
    .from(membershipType)
    .where(inArray(membershipType.productId, productIds));

  const lines = p.lines.map((l, i) => {
    const prod = byId.get(l.productId);
    if (!prod) throw new Rejected(`Produit inconnu (ligne ${i + 1}).`);
    const qtyMilli = parseQtyToMilli(l.qty)!;
    if (qtyMilli <= 0) throw new Rejected(`Quantité invalide (ligne ${i + 1}).`);
    const unitPriceCents = decimalToCents(l.unitPrice);
    const discountCents = decimalToCents(l.discount);
    if (unitPriceCents < 0 || discountCents < 0)
      throw new Rejected(`Montant négatif (ligne ${i + 1}).`);
    if (prod.status !== 'ACTIVE')
      warn(ctx, 'PRODUCT_INACTIVE', `${prod.name} n’est plus actif au catalogue.`);
    const catalogCents = decimalToCents(prod.salePrice);
    if (unitPriceCents !== catalogCents) {
      warn(
        ctx,
        'PRICE_CHANGED',
        `${prod.name} : prix appliqué ${l.unitPrice} €, catalogue ${prod.salePrice} € (R-VTE-06).`,
      );
    }
    return {
      l,
      prod,
      qtyMilli,
      unitPriceCents,
      discountCents,
      totalCents: lineTotalCents({ qtyMilli, unitPriceCents, discountCents }),
    };
  });
  const totalCents = lines.reduce((s, x) => s + x.totalCents, 0);
  if (totalCents < 0) throw new Rejected('Le total du ticket est négatif.');
  if (totalCents !== decimalToCents(p.total))
    throw new Rejected('Total du ticket incohérent avec ses lignes.');

  const payments = p.payments.map((x) => ({ ...x, cents: decimalToCents(x.amount) }));
  if (payments.some((x) => x.cents <= 0)) throw new Rejected('Règlement nul ou négatif.');
  if (payments.reduce((s, x) => s + x.cents, 0) !== totalCents)
    throw new Rejected('Le ticket n’est pas soldé.');

  // Member and household. Wallet payments need a household (R-VTE-02).
  let householdId: string | null = null;
  let buyer: { firstName: string; email: string | null } | null = null;
  if (p.memberId) {
    const m = await tx.query.member.findFirst({ where: eq(member.id, p.memberId) });
    if (!m) throw new Rejected('Adhérent inconnu.');
    if (m.status === 'INACTIVE' || m.status === 'ARCHIVED') {
      warn(ctx, 'MEMBER_INACTIVE', `${m.firstName} ${m.lastName} n’est plus actif.`);
    }
    householdId = m.householdId;
    buyer = { firstName: m.firstName, email: m.email };
  }
  const needsHousehold = payments.some((x) => x.method === 'WALLET' || x.changeToWallet);
  if (needsHousehold && !householdId)
    throw new Rejected('Le paiement par cagnotte exige un adhérent rattaché à un foyer.');

  const number = await nextSaleNumber(tx, soldAt);
  const discountCents = lines.reduce((s, x) => s + x.discountCents, 0);
  await tx.insert(sale).values({
    id: saleId,
    number,
    provisionalNumber: p.provisionalNumber,
    deviceSeq,
    deviceId: ctx.deviceId,
    sessionId: session.id,
    cashierId: p.cashierId,
    memberId: p.memberId,
    householdId,
    soldAt,
    total: centsToDecimal(totalCents),
    discountTotal: centsToDecimal(discountCents),
    hasServices: lines.some((x) => x.prod.kind === 'SERVICE'),
    warnings: ctx.warnings.length ? ctx.warnings : null,
  });

  await tx.insert(saleLine).values(
    lines.map((x, i) => ({
      saleId,
      lineNo: i + 1,
      productId: x.prod.id,
      label: x.l.label,
      qty: milliToDecimal(x.qtyMilli),
      unitPrice: x.l.unitPrice,
      catalogPrice: x.prod.salePrice,
      discount: x.l.discount,
      lineTotal: centsToDecimal(x.totalCents),
      vatRate: x.prod.vatRate,
    })),
  );
  await tx.insert(salePayment).values(
    payments.map((x) => ({
      saleId,
      method: x.method,
      amount: centsToDecimal(x.cents),
      tendered: x.tendered ?? null,
      change: x.change ?? null,
      changeToWallet: x.changeToWallet ?? false,
    })),
  );

  // Stock decreases immediately, services excluded (R-VTE-10).
  await moveStock(
    ctx,
    lines
      .filter((x) => x.prod.kind === 'GOODS')
      .map((x) => ({ productId: x.prod.id, qtyMilli: -x.qtyMilli })),
    'SALE',
    saleId,
    soldAt,
  );

  // Cagnotte: the household is debited in the same transaction (R-CAG-02).
  if (householdId) {
    const walletCents = payments
      .filter((x) => x.method === 'WALLET')
      .reduce((s, x) => s + x.cents, 0);
    if (walletCents > 0) {
      const before = await lockedBalanceCents(tx, householdId);
      const overdraft = (await loadSettings(tx))['wallet.overdraftLimit'].amount;
      const allowed = walletPaymentAllowed(before, walletCents, decimalToCents(overdraft));
      if (!allowed) {
        // The sale happened; the overdraft is recorded and reported (R-SYNC-04).
        warn(
          ctx,
          'WALLET_OVERDRAFT',
          `Découvert de cagnotte constaté : solde ${centsToDecimal(before - walletCents)} €.`,
        );
      }
      await tx.insert(walletEntry).values({
        householdId,
        at: soldAt,
        amount: centsToDecimal(-walletCents),
        kind: 'PURCHASE',
        saleId,
        comment: number,
        forcedBy: !allowed ? (p.walletOverdraftForcedBy ?? null) : null,
        createdBy: p.cashierId,
      });
      if (!allowed && p.walletOverdraftForcedBy) {
        await audit(tx, ctx.req, {
          action: 'wallet.overdraft_forced',
          entity: 'household',
          entityId: householdId,
          after: { saleId, forcedBy: p.walletOverdraftForcedBy },
        });
      }
    }
    // R-CAG-05: change paid into the cagnotte.
    for (const x of payments.filter((y) => y.changeToWallet && y.change)) {
      const changeCents = decimalToCents(x.change!);
      if (changeCents <= 0) continue;
      const [pay] = await tx
        .insert(memberPayment)
        .values({
          householdId,
          date: toParisDate(soldAt),
          amount: centsToDecimal(changeCents),
          purpose: 'TOPUP',
          method: 'CASH',
          cashSessionId: session.id,
          saleId,
          comment: `Monnaie du ticket ${number}`,
          createdBy: p.cashierId,
        })
        .returning({ id: memberPayment.id });
      await tx
        .insert(walletEntry)
        .values({
          householdId,
          at: soldAt,
          amount: centsToDecimal(changeCents),
          kind: 'TOPUP',
          paymentMethod: 'CASH',
          saleId,
          paymentId: pay!.id,
          comment: `Monnaie du ticket ${number}`,
          createdBy: p.cashierId,
        });
    }
  }

  // Memberships sold as service lines (R-ADH-05).
  for (const x of lines) {
    const type = types.find((t) => t.productId === x.prod.id);
    if (!type) continue;
    if (!householdId) {
      if (type.durationMonths > 0)
        warn(
          ctx,
          'MEMBERSHIP_NO_HOUSEHOLD',
          `${type.label} vendue sans adhérent : aucune adhésion enregistrée.`,
        );
      continue;
    }
    const period = membershipPeriod(
      toParisDate(soldAt),
      type.durationMonths,
      await currentMembershipEnd(tx, householdId),
    );
    await tx
      .insert(membership)
      .values({
        householdId,
        typeId: type.id,
        startDate: period.start,
        endDate: period.end,
        amount: centsToDecimal(x.totalCents),
        saleId,
        createdBy: p.cashierId,
      });
  }

  // R-VTE-11: the receipt is queued only now that the sale is recorded.
  if (p.emailReceipt && buyer?.email) {
    const cashier = await tx.query.member.findFirst({
      where: eq(member.id, p.cashierId),
      columns: { firstName: true, lastName: true },
    });
    await queueEmail(
      tx,
      saleReceiptEmail(buyer.email, buyer.firstName, {
        number,
        soldAt,
        total: centsToDecimal(totalCents),
        lines: lines.map((x) => ({
          label: x.l.label,
          qty: milliToDecimal(x.qtyMilli),
          unitPrice: x.l.unitPrice,
          lineTotal: centsToDecimal(x.totalCents),
        })),
        payments: payments.map((x) => ({
          method: x.method as PaymentMethod,
          amount: centsToDecimal(x.cents),
        })),
        cashierName: cashier ? `${cashier.firstName} ${cashier.lastName}` : null,
      }),
    );
    await tx.update(sale).set({ emailSentAt: new Date() }).where(eq(sale.id, saleId));
  }
  if (ctx.warnings.length)
    await tx.update(sale).set({ warnings: ctx.warnings }).where(eq(sale.id, saleId));
  return number;
}

async function moveStock(
  ctx: Ctx,
  moves: { productId: string; qtyMilli: number }[],
  kind: 'SALE' | 'SALE_CANCEL',
  saleId: string,
  at: Date,
) {
  for (const m of moves) {
    const qty = milliToDecimal(m.qtyMilli);
    await ctx.tx
      .insert(stockMovement)
      .values({ productId: m.productId, at, qty, kind, sourceType: 'sale', sourceId: saleId });
    await ctx.tx
      .update(product)
      .set({
        stockQty: sql`${product.stockQty} + ${qty}::numeric`,
        updatedAt: sql`${product.updatedAt}`,
      })
      .where(eq(product.id, m.productId));
  }
}

// --- Cancellation (R-VTE-12) ----------------------------------------------------------

async function cancelSale(
  ctx: Ctx,
  p: Extract<SyncOp, { kind: 'SALE_CANCEL' }>['payload'],
  deviceSeq: number,
): Promise<string> {
  const { tx } = ctx;
  const session = await sessionOf(ctx, p.sessionId);
  const original = await tx.query.sale.findFirst({ where: eq(sale.id, p.saleId) });
  if (!original) throw new Rejected('Ticket à annuler introuvable.');
  if (original.cancelsSaleId) throw new Rejected('Un ticket d’annulation ne peut pas être annulé.');
  if (original.status === 'CANCELLED') throw new Rejected('Ce ticket est déjà annulé.');
  // A ticket of the current session can be cancelled at the till; older ones need ADMIN.
  if (original.sessionId !== session.id && !hasAnyRole(ctx.req.user!.roles, ['ADMIN'])) {
    throw new Rejected('Seul un administrateur peut annuler un ticket d’une session précédente.');
  }
  const at = new Date(p.at);
  const lines = await tx
    .select()
    .from(saleLine)
    .where(eq(saleLine.saleId, original.id))
    .orderBy(saleLine.lineNo);
  const pays = await tx.select().from(salePayment).where(eq(salePayment.saleId, original.id));
  const prods = await tx
    .select({ id: product.id, kind: product.kind })
    .from(product)
    .where(
      inArray(
        product.id,
        lines.map((l) => l.productId),
      ),
    );
  const kindOf = new Map(prods.map((x) => [x.id, x.kind]));
  const neg = (v: string) => centsToDecimal(-decimalToCents(v));
  const negQty = (v: string) => milliToDecimal(-parseQtyToMilli(v)!);

  const number = await nextSaleNumber(tx, at);
  await tx.insert(sale).values({
    id: p.cancelSaleId,
    number,
    provisionalNumber: p.provisionalNumber,
    deviceSeq,
    deviceId: ctx.deviceId,
    sessionId: session.id,
    cashierId: p.cashierId,
    memberId: original.memberId,
    householdId: original.householdId,
    soldAt: at,
    total: neg(original.total),
    discountTotal: neg(original.discountTotal),
    cancelsSaleId: original.id,
    hasServices: original.hasServices,
  });
  await tx
    .insert(saleLine)
    .values(
      lines.map((l) => ({
        saleId: p.cancelSaleId,
        lineNo: l.lineNo,
        productId: l.productId,
        label: l.label,
        qty: negQty(l.qty),
        unitPrice: l.unitPrice,
        catalogPrice: l.catalogPrice,
        discount: neg(l.discount),
        lineTotal: neg(l.lineTotal),
        vatRate: l.vatRate,
      })),
    );
  // Each payment is given back by the same method (cash out of the drawer, cagnotte refunded…).
  await tx
    .insert(salePayment)
    .values(pays.map((x) => ({ saleId: p.cancelSaleId, method: x.method, amount: neg(x.amount) })));
  await moveStock(
    ctx,
    lines
      .filter((l) => kindOf.get(l.productId) === 'GOODS')
      .map((l) => ({ productId: l.productId, qtyMilli: parseQtyToMilli(l.qty)! })),
    'SALE_CANCEL',
    p.cancelSaleId,
    at,
  );
  const walletCents = pays
    .filter((x) => x.method === 'WALLET')
    .reduce((s, x) => s + decimalToCents(x.amount), 0);
  if (walletCents > 0 && original.householdId) {
    await lockedBalanceCents(tx, original.householdId);
    await tx
      .insert(walletEntry)
      .values({
        householdId: original.householdId,
        at,
        amount: centsToDecimal(walletCents),
        kind: 'REFUND',
        saleId: p.cancelSaleId,
        comment: `Annulation du ticket ${original.number}`,
        createdBy: p.cashierId,
      });
  }
  await tx.update(membership).set({ cancelledAt: at }).where(eq(membership.saleId, original.id));
  await tx.update(sale).set({ status: 'CANCELLED' }).where(eq(sale.id, original.id));
  await audit(tx, ctx.req, {
    action: 'sale.cancel',
    entity: 'sale',
    entityId: original.id,
    before: { number: original.number, total: original.total },
    after: { cancelledBy: number, reason: p.reason ?? null },
  });
  return number;
}

// --- Top-up at the till (R-CAG-01, R-CAG-06) -----------------------------------------

async function topup(ctx: Ctx, p: Extract<SyncOp, { kind: 'WALLET_TOPUP' }>['payload']) {
  const { tx } = ctx;
  const session = await sessionOf(ctx, p.sessionId);
  const h = await tx.query.household.findFirst({ where: eq(household.id, p.householdId) });
  if (!h) throw new Rejected('Foyer inconnu.');
  const cents = decimalToCents(p.amount);
  if (cents <= 0) throw new Rejected('Le versement doit être positif.');
  const at = new Date(p.at);
  const before = await lockedBalanceCents(tx, h.id);
  const [pay] = await tx
    .insert(memberPayment)
    .values({
      householdId: h.id,
      date: toParisDate(at),
      amount: p.amount,
      purpose: 'TOPUP',
      method: p.method,
      cashSessionId: session.id,
      createdBy: p.cashierId,
    })
    .returning({ id: memberPayment.id });
  await tx
    .insert(walletEntry)
    .values({
      householdId: h.id,
      at,
      amount: p.amount,
      kind: 'TOPUP',
      paymentMethod: p.method,
      paymentId: pay!.id,
      createdBy: p.cashierId,
    });
  if (p.emailReceipt)
    await sendTopupReceipt(tx, h.id, h.referentMemberId, {
      at,
      amountCents: cents,
      beforeCents: before,
      method: p.method,
    });
}

export async function sendTopupReceipt(
  tx: Tx,
  householdId: string,
  referentId: string | null,
  r: { at: Date; amountCents: number; beforeCents: number; method: PaymentMethod },
) {
  const referent = referentId
    ? await tx.query.member.findFirst({ where: eq(member.id, referentId) })
    : null;
  const to = referent?.email
    ? referent
    : await tx.query.member.findFirst({
        where: and(eq(member.householdId, householdId), sql`${member.email} is not null`),
      });
  if (to?.email) await queueEmail(tx, topupReceiptEmail(to.email, to.firstName, r));
}
