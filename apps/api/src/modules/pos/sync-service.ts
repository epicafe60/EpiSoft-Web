import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  cashSession,
  cashSessionAlias,
  household,
  inventoryLine,
  inventorySession,
  member,
  memberPayment,
  membership,
  membershipType,
  posDevice,
  preorder,
  product,
  sale,
  saleLine,
  salePayment,
  session as signInSession,
  syncReceipt,
  syncRejection,
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
  paymentProblem,
  saleAlreadyCounted,
  walletPaymentAllowed,
  type CashierCheck,
  type PaymentMethod,
  type SyncOp,
  type SyncResult,
  type SyncWarning,
  clockSkew,
  sessionDayStale,
  ticketWarnings,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toParisDate } from '../../lib/dates';
import { queueEmail } from '../../lib/mail';
import { saleReceiptEmail, topupReceiptEmail } from '../../lib/receipts';
import { alertNow } from '../../lib/alerts';
import { loadSettings } from '../admin/settings-store';
import { recordMovement } from '../stock/ledger';
import { nextSaleNumber } from './numbers';
import { currentMembershipEnd, lockedBalanceCents } from './wallet';

/** A business rule refused the operation; it is answered REJECTED, not as an error. */
export class Rejected extends Error {}

/**
 * The device itself is refused (not known to the server, or switched off): every operation of the
 * request would be refused for the same reason, so the till is told with a code it can act on
 * (R-OFF-03: nothing is lost, the operations stay in its queue).
 */
export class DeviceRefused extends Rejected {
  constructor(
    readonly code: 'DEVICE_UNKNOWN' | 'DEVICE_DISABLED',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The operation cannot be processed *yet* (a cancellation that reached the server before the
 * ticket it cancels). Nothing is stored: the till sends it again and it goes through once the
 * ticket is there. Refusing it for good would lose the cancellation without a trace.
 */
export class NotYet extends Error {}

/** How long an operation may wait for what it depends on before it is refused for good. */
const MAX_WAIT_MS = 24 * 3_600_000;

/**
 * « Not yet » while the operation is recent; past a day, the missing piece will not come (a till
 * whose storage was wiped…): the operation is refused and recorded, so it shows in Surveillance
 * instead of blocking every later ticket of the till.
 */
function waitOrRefuse(at: Date, waiting: string, final: string): never {
  if (Date.now() - at.getTime() > MAX_WAIT_MS)
    throw new Rejected(`${final} (attendu plus de 24 h)`);
  throw new NotYet(waiting);
}

interface Ctx {
  tx: Tx;
  req: FastifyRequest;
  config: Config;
  deviceId: string;
  warnings: SyncWarning[];
  /** The cashier of the operation holds the CAISSE role (set by checkCashier). */
  cashierKnown?: boolean;
}

const warn = (ctx: Ctx, code: string, message: string) => ctx.warnings.push({ code, message });

/**
 * C02: when an operation of a session is written, by the database clock at that very moment, not
 * at the start of the transaction (`now()`). An operation that waited for a closing is thus dated
 * after it, and the closing knows it did not count it.
 */
const recordedNow = sql`clock_timestamp()`;

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
  if (!device)
    throw new DeviceRefused(
      'DEVICE_UNKNOWN',
      'Ce poste de caisse n’est pas connu du serveur. Redéclarez-le : les ventes en attente sont conservées.',
    );
  if (!device.active)
    throw new DeviceRefused(
      'DEVICE_DISABLED',
      'Ce poste de caisse a été désactivé par un administrateur. Les ventes en attente sont conservées.',
    );

  const results: SyncResult[] = [];
  for (const op of [...ops].sort((a, b) => a.deviceSeq - b.deviceSeq)) {
    results.push(await processOne(db, req, config, deviceId, op));
  }
  await db.update(posDevice).set({ lastSyncAt: new Date() }).where(eq(posDevice.id, deviceId));
  await restrictToTill(db, req, ops);
  return results;
}

/**
 * R-SES-07: a ticket of another cashier than the holder restricts the session to the till, like
 * POST /pos/cashier. A change of cashier made offline thus closes the holder's other rights as
 * soon as the network is back, whatever the till's screen does.
 */
async function restrictToTill(db: Db, req: FastifyRequest, ops: SyncOp[]) {
  const u = req.user!;
  if (u.tillCashierId) return;
  const others = [...ops]
    .sort((a, b) => b.deviceSeq - a.deviceSeq)
    .map((o) => (o.kind === 'SESSION_OPEN' ? null : o.payload.cashierId))
    .filter((id): id is string => !!id && id !== u.id);
  if (!others.length) return;
  // Only a real cashier keeps the till (an unknown id would break the link to the member).
  const [known] = await db
    .select({ id: userRole.memberId })
    .from(userRole)
    .where(and(inArray(userRole.memberId, others), eq(userRole.roleCode, 'CAISSE')));
  const other = known?.id;
  if (!other) return;
  await db
    .update(signInSession)
    .set({ tillCashierId: other })
    .where(eq(signInSession.id, u.sessionId));
  u.tillCashierId = other;
}

async function processOne(
  db: Db,
  req: FastifyRequest,
  config: Config,
  deviceId: string,
  op: SyncOp,
): Promise<SyncResult> {
  let fresh = false;
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'op:' + op.id}))`);
      const done = await tx.query.syncReceipt.findFirst({ where: eq(syncReceipt.clientId, op.id) });
      if (done) return done.result as SyncResult;

      const ctx: Ctx = { tx, req, config, deviceId, warnings: [] };
      let result: SyncResult;
      try {
        // Savepoint: a rejection undoes the partial work but keeps the receipt below.
        result = await tx.transaction(async (sp) => {
          const inner = { ...ctx, tx: sp };
          const done = await dispatch(inner, op);
          return {
            id: op.id,
            status: 'OK' as const,
            warnings: ctx.warnings,
            ...(done.number ? { number: done.number } : {}),
            ...(done.sessionId ? { sessionId: done.sessionId } : {}),
          };
        });
      } catch (e) {
        if (!(e instanceof Rejected)) throw e;
        result = { id: op.id, status: 'REJECTED', warnings: ctx.warnings, error: e.message };
        // Kept for the administrators: a refused ticket must never vanish without a trace.
        await tx
          .insert(syncRejection)
          .values({
            deviceId,
            opId: op.id,
            kind: op.kind,
            payload: op.payload,
            reason: e.message,
          })
          .onConflictDoNothing();
        await audit(tx, req, {
          action: 'sync.rejected',
          entity: 'sync_rejection',
          entityId: op.id,
          after: { kind: op.kind, reason: e.message },
        });
      }
      await tx.insert(syncReceipt).values({ clientId: op.id, deviceId, kind: op.kind, result });
      fresh = true;
      return result;
    });
    if (fresh && result.status === 'REJECTED') {
      void alertNow(
        db,
        config,
        ['ADMIN', 'COMPTA'],
        {
          subject: 'Épicafé : un ticket de caisse a été refusé',
          lines: [
            'Un poste de caisse a envoyé une opération que le serveur a refusée.',
            `Motif : ${result.error ?? 'inconnu'}`,
            'Ouvrez Surveillance › Tickets à vérifier pour la voir et la faire ressaisir.',
          ],
        },
        {
          title: 'Ticket refusé',
          body: result.error ?? 'Un ticket a été refusé.',
          url: '/surveillance',
        },
        req.log,
      ).catch((err) => req.log.error({ err }, 'alerte de ticket refusé'));
    }
    return result;
  } catch (e) {
    if (e instanceof NotYet) throw e;
    req.log.error({ err: e, op: op.id, kind: op.kind }, 'échec de traitement d’une opération');
    // Not recorded: the device retries later (R-OFF-03).
    throw e;
  }
}

async function dispatch(ctx: Ctx, op: SyncOp): Promise<{ number?: string; sessionId?: string }> {
  switch (op.kind) {
    case 'SESSION_OPEN':
      return { sessionId: await openSession(ctx, op.payload) };
    case 'SALE':
      // The sale id is the operation id, generated on the device (§6.2: idempotency key).
      return { number: await recordSale(ctx, op.payload, op.deviceSeq, op.id) };
    case 'SALE_CANCEL':
      return { number: await cancelSale(ctx, op.payload, op.deviceSeq) };
    case 'WALLET_TOPUP':
      await topup(ctx, op.payload);
      return {};
  }
}

// --- Session ------------------------------------------------------------------------

/**
 * R-SES-05: one drawer, one closing. The first till to open a session opens the shop's; a till
 * that opens another one (offline, or at the same moment) is attached to the open one: the
 * session id it generated becomes an alias, its float is ignored. Returns the session to use.
 */
async function openSession(
  ctx: Ctx,
  p: Extract<SyncOp, { kind: 'SESSION_OPEN' }>['payload'],
): Promise<string> {
  const { tx } = ctx;
  const alias = await tx.query.cashSessionAlias.findFirst({
    where: eq(cashSessionAlias.aliasId, p.sessionId),
  });
  if (alias) return alias.sessionId;
  const existing = await tx.query.cashSession.findFirst({ where: eq(cashSession.id, p.sessionId) });
  if (existing) return existing.id;
  // Two tills opening at the same moment: one after the other.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cash_session_open'))`);
  const open = await tx.query.cashSession.findFirst({ where: eq(cashSession.status, 'OPEN') });
  if (open) {
    await tx.insert(cashSessionAlias).values({ aliasId: p.sessionId, sessionId: open.id });
    await audit(tx, ctx.req, {
      action: 'session.join',
      entity: 'cash_session',
      entityId: open.id,
      after: { alias: p.sessionId },
    });
    return open.id;
  }
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
  return p.sessionId;
}

async function sessionOf(ctx: Ctx, sessionId: string, at: Date) {
  // R-EVO-06: a session is the shop's, whichever till opened it: another till may sell in it.
  const alias = await ctx.tx.query.cashSessionAlias.findFirst({
    where: eq(cashSessionAlias.aliasId, sessionId),
  });
  // C02: shared lock, held until the operation is recorded. A closing (or a regularization)
  // locks the session for update: it waits for the operations being recorded, which it then
  // counts, and an operation arriving meanwhile waits for it, then sees the session closed.
  const [s] = await ctx.tx
    .select()
    .from(cashSession)
    .where(eq(cashSession.id, alias?.sessionId ?? sessionId))
    .for('share');
  if (!s) {
    // The session is opened by an operation whose id is the session id. Not received yet (the
    // till that opened it is offline, or sent it later): say « not yet », the ticket is kept
    // and sent again. Received and refused: there is no session to sell in.
    const opened = await ctx.tx.query.syncReceipt.findFirst({
      where: eq(syncReceipt.clientId, sessionId),
    });
    if (!opened)
      waitOrRefuse(
        at,
        'La session de caisse n’est pas encore arrivée : le poste réessaiera.',
        'La session de caisse n’est jamais arrivée sur le serveur',
      );
    throw new Rejected('La session de caisse avait été refusée : on ne peut pas y vendre.');
  }
  if (s.status === 'CLOSED')
    warn(ctx, 'SESSION_CLOSED', 'La session était déjà clôturée (clôture forcée).');
  // R-SES-05: the shop's session is the day's; a ticket of a later day is kept, and flagged.
  if (s.status === 'OPEN' && sessionDayStale(s.openedAt, at))
    warn(
      ctx,
      'SESSION_PREVIOUS_DAY',
      'La caisse de la veille n’a pas été clôturée : ce ticket est dans la session d’un jour précédent.',
    );
  return s;
}

async function checkCashier(ctx: Ctx, cashierId: string) {
  const roles = await ctx.tx
    .select({ code: userRole.roleCode })
    .from(userRole)
    .where(eq(userRole.memberId, cashierId));
  ctx.cashierKnown = roles.some((r) => r.code === 'CAISSE');
  if (!ctx.cashierKnown) {
    warn(ctx, 'CASHIER_ROLE', 'Le caissier indiqué n’a pas le rôle Caisse.');
  }
}

/**
 * The journal names the cashier as the author only when they are a cashier. The till declares the
 * cashier, so a made-up or non-cashier id must never put words in someone else's mouth (an
 * administrator's name on a ticket): the author then stays the person who sent it.
 */
const asCashier = (ctx: Ctx, p: { cashierId: string }) =>
  ctx.cashierKnown ? { cashier: { id: p.cashierId } } : {};

/**
 * R-SES-07: the cashier of a till operation, and how it was established. The person signed in is
 * SESSION; anyone else is PIN when the till says the code was typed, DECLARED otherwise. Never
 * refused (an offline ticket must not be lost): an unchecked cashier where the association asks
 * for the code is flagged.
 */
async function noteCashier(
  ctx: Ctx,
  p: { cashierId: string; cashierCheck?: CashierCheck },
): Promise<CashierCheck> {
  await checkCashier(ctx, p.cashierId);
  if (p.cashierId === ctx.req.user!.id) return 'SESSION';
  const check: CashierCheck = p.cashierCheck === 'PIN' ? 'PIN' : 'DECLARED';
  if (check === 'DECLARED' && (await loadSettings(ctx.tx))['pos.cashierSwitch'].requirePin)
    warn(
      ctx,
      'CASHIER_UNCHECKED',
      'Caissier choisi sans son code (pas encore de code, ou poste hors ligne) : à confirmer avec lui.',
    );
  return check;
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
  const soldAt = new Date(p.soldAt);
  const session = await sessionOf(ctx, p.sessionId, soldAt);
  const cashierCheck = await noteCashier(ctx, p);

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
        `${prod.name} : prix appliqué ${l.unitPrice} €, catalogue ${prod.salePrice} €.`,
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
  // C01: cash given, change and change into the cagnotte must add up, whatever the client sent.
  for (const x of payments) {
    const problem = paymentProblem({
      method: x.method,
      amountCents: x.cents,
      tenderedCents: x.tendered == null ? null : decimalToCents(x.tendered),
      changeCents: x.change == null ? null : decimalToCents(x.change),
      changeToWallet: x.changeToWallet ?? false,
    });
    if (problem) throw new Rejected(`Règlement incohérent : ${problem}`);
  }

  // Unusual values never refuse the sale: they are recorded with it for the treasurer to check.
  const thresholds = (await loadSettings(tx))['controls.thresholds'];
  const changeCents = payments.reduce(
    (s, x) => s + (x.changeToWallet || !x.change ? 0 : decimalToCents(x.change)),
    0,
  );
  for (const w of ticketWarnings(
    lines.map((x) => ({
      label: x.prod.name,
      qtyMilli: x.qtyMilli,
      unitPriceCents: x.unitPriceCents,
      catalogPriceCents: decimalToCents(x.prod.salePrice),
      discountCents: x.discountCents,
    })),
    changeCents,
    thresholds,
  ))
    warn(ctx, w.code, w.message);
  const skew = clockSkew(soldAt, new Date(), thresholds);
  if (skew)
    warn(
      ctx,
      'CLOCK_SKEW',
      skew === 'FUTURE'
        ? 'L’horloge du poste de caisse est en avance : vérifiez la date et l’heure du poste.'
        : 'Ce ticket est très ancien (poste resté hors ligne ?) : vérifiez la date du ticket.',
    );
  if (payments.reduce((s, x) => s + x.cents, 0) !== totalCents)
    throw new Rejected('Le ticket n’est pas soldé.');

  // Member and household. Wallet payments need a household (R-VTE-02).
  let householdId: string | null = null;
  let buyer: { firstName: string; email: string | null; optOut: boolean } | null = null;
  if (p.memberId) {
    const m = await tx.query.member.findFirst({ where: eq(member.id, p.memberId) });
    if (!m) throw new Rejected('Adhérent inconnu.');
    if (m.status === 'INACTIVE' || m.status === 'ARCHIVED') {
      warn(ctx, 'MEMBER_INACTIVE', `${m.firstName} ${m.lastName} n’est plus actif.`);
    }
    householdId = m.householdId;
    buyer = { firstName: m.firstName, email: m.email, optOut: m.ticketEmailOptOut };
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
    createdAt: recordedNow,
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
  await compensateCountedSale(
    ctx,
    lines
      .filter((x) => x.prod.kind === 'GOODS')
      .map((x) => ({ productId: x.prod.id, name: x.prod.name, qtyMilli: x.qtyMilli })),
    saleId,
    soldAt,
  );
  const goodsIds = lines.filter((x) => x.prod.kind === 'GOODS').map((x) => x.prod.id);
  if (goodsIds.length) {
    const below = await tx
      .select({ name: product.name, stockQty: product.stockQty })
      .from(product)
      .where(and(inArray(product.id, goodsIds), sql`${product.stockQty} < 0`));
    for (const b of below)
      warn(
        ctx,
        'STOCK_NEGATIVE',
        `${b.name} : le stock est négatif (${Number(b.stockQty)}) après cette vente. Un inventaire ou une réception manque peut-être.`,
      );
  }

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
      // The person who forces an overdraft vouches for it with their own role: only the holder of
      // the session, keeping the till themself (R-SES-07: never another cashier on their behalf).
      const forcedBy =
        !allowed &&
        p.walletOverdraftForcedBy &&
        p.walletOverdraftForcedBy === ctx.req.user!.id &&
        p.cashierId === ctx.req.user!.id
          ? p.walletOverdraftForcedBy
          : null;
      await tx.insert(walletEntry).values({
        householdId,
        at: soldAt,
        amount: centsToDecimal(-walletCents),
        kind: 'PURCHASE',
        saleId,
        comment: number,
        forcedBy,
        createdBy: p.cashierId,
      });
      if (forcedBy) {
        await audit(tx, ctx.req, {
          action: 'wallet.overdraft_forced',
          entity: 'household',
          entityId: householdId,
          after: { saleId, forcedBy },
        });
      }
    }
    // R-CAG-05: change paid into the cagnotte.
    for (const x of payments.filter((y) => y.changeToWallet && y.change)) {
      const changeCents = decimalToCents(x.change!);
      if (changeCents <= 0) continue;
      // Every writer of a cagnotte takes its lock, a credit too (a no-op if taken just above).
      await lockedBalanceCents(tx, householdId!);
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
          createdAt: recordedNow,
        })
        .returning({ id: memberPayment.id });
      await tx.insert(walletEntry).values({
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
    await tx.insert(membership).values({
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
  // R-EVO-40: automatic for every member with an e-mail address who did not opt out.
  if (buyer?.email && !buyer.optOut) {
    let balance: { beforeCents: number; afterCents: number } | undefined;
    if (householdId) {
      const afterCents = await lockedBalanceCents(tx, householdId);
      const delta =
        -payments.filter((x) => x.method === 'WALLET').reduce((s, x) => s + x.cents, 0) +
        payments
          .filter((x) => x.changeToWallet && x.change)
          .reduce((s, x) => s + Math.max(0, decimalToCents(x.change!)), 0);
      balance = { beforeCents: afterCents - delta, afterCents };
    }
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
        balance,
      }),
    );
    await tx.update(sale).set({ emailSentAt: new Date() }).where(eq(sale.id, saleId));
  }
  // R-PRE-03: the pre-order collected at the till is closed and linked to its ticket.
  if (p.preorderId) {
    const done = await tx
      .update(preorder)
      .set({ status: 'PICKED_UP', saleId, updatedAt: new Date() })
      .where(and(eq(preorder.id, p.preorderId), inArray(preorder.status, ['SUBMITTED', 'READY'])))
      .returning({ id: preorder.id });
    if (done.length === 0)
      warn(
        ctx,
        'PREORDER_NOT_OPEN',
        'La précommande liée n’était plus ouverte (déjà retirée ou annulée).',
      );
  }
  if (ctx.warnings.length)
    await tx.update(sale).set({ warnings: ctx.warnings }).where(eq(sale.id, saleId));
  await audit(tx, ctx.req, {
    action: 'sale.create',
    entity: 'sale',
    entityId: saleId,
    ...asCashier(ctx, p),
    after: {
      cashierCheck,
      number,
      total: centsToDecimal(totalCents),
      payments: payments.map((x) => ({ method: x.method, amount: centsToDecimal(x.cents) })),
      memberId: p.memberId,
      cashierId: p.cashierId,
      soldAt: soldAt.toISOString(),
      ...(ctx.warnings.length ? { warnings: ctx.warnings.map((w) => w.code) } : {}),
    },
  });
  return number;
}

async function moveStock(
  ctx: Ctx,
  moves: { productId: string; qtyMilli: number }[],
  kind: 'SALE' | 'SALE_CANCEL',
  saleId: string,
  at: Date,
) {
  // In product id order, as the inventory validation locks them: two transactions never wait
  // for each other in a circle.
  for (const m of [...moves].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
    await recordMovement(ctx.tx, {
      productId: m.productId,
      qtyMilli: m.qtyMilli,
      kind,
      sourceType: 'sale',
      sourceId: saleId,
      at,
    });
  }
}

/**
 * Audit KV2, C04: a sale that arrives after an inventory already counted the product it sold (sold
 * between the opening and the count, received after the validation). The count saw the product
 * gone, the sale takes it off again: an INVENTORY movement gives it back, with a warning on the
 * ticket so that the stock team knows. Never refuses the sale.
 */
async function compensateCountedSale(
  ctx: Ctx,
  goods: { productId: string; name: string; qtyMilli: number }[],
  saleId: string,
  soldAt: Date,
) {
  if (!goods.length) return;
  const counts = await ctx.tx
    .select({
      productId: inventoryLine.productId,
      sessionId: inventorySession.id,
      label: inventorySession.label,
      openedAt: inventorySession.openedAt,
      countedAt: inventoryLine.countedAt,
    })
    .from(inventoryLine)
    .innerJoin(inventorySession, eq(inventorySession.id, inventoryLine.sessionId))
    .where(
      and(
        inArray(
          inventoryLine.productId,
          goods.map((g) => g.productId),
        ),
        isNotNull(inventorySession.validatedAt),
        isNotNull(inventoryLine.countedAt),
        lte(inventorySession.openedAt, soldAt),
        gte(inventoryLine.countedAt, soldAt),
      ),
    );
  for (const g of goods) {
    const inv = counts.find((c) => c.productId === g.productId && saleAlreadyCounted(soldAt, c));
    if (!inv) continue;
    await recordMovement(ctx.tx, {
      productId: g.productId,
      qtyMilli: g.qtyMilli,
      kind: 'INVENTORY',
      sourceType: 'inventory_late_sale',
      sourceId: saleId,
      comment: `Régularisation : vente arrivée après l’inventaire « ${inv.label} », déjà comptée`,
      at: new Date(),
    });
    warn(
      ctx,
      'INVENTORY_LATE_SALE',
      `${g.name} : vente arrivée après l’inventaire « ${inv.label} » qui l’avait déjà comptée ; le stock a été régularisé.`,
    );
  }
}

// --- Cancellation (R-VTE-12) ----------------------------------------------------------

async function cancelSale(
  ctx: Ctx,
  p: Extract<SyncOp, { kind: 'SALE_CANCEL' }>['payload'],
  deviceSeq: number,
): Promise<string> {
  const { tx } = ctx;
  const session = await sessionOf(ctx, p.sessionId, new Date(p.at));
  const cashierCheck = await noteCashier(ctx, p);
  // Locked: two tills cancelling the same ticket at once, the second one sees it cancelled.
  const [original] = await tx.select().from(sale).where(eq(sale.id, p.saleId)).for('update');
  if (!original) {
    // Never received: it is on its way (the till sends in order), say « not yet ». Received and
    // refused: there will never be a ticket to cancel.
    const origin = await tx.query.syncReceipt.findFirst({
      where: eq(syncReceipt.clientId, p.saleId),
    });
    if (!origin)
      waitOrRefuse(
        new Date(p.at),
        'Le ticket à annuler n’est pas encore arrivé : le poste réessaiera.',
        'Le ticket à annuler n’est jamais arrivé sur le serveur',
      );
    throw new Rejected('Le ticket à annuler avait été refusé : il n’y a rien à annuler.');
  }
  if (original.cancelsSaleId) throw new Rejected('Un ticket d’annulation ne peut pas être annulé.');
  if (original.status === 'CANCELLED') throw new Rejected('Ce ticket est déjà annulé.');
  // A ticket of the current session can be cancelled at the till; older ones need ADMIN, and
  // the administrator keeping the till themself (R-SES-07: another cashier never uses their rights).
  const adminAtTill =
    hasAnyRole(ctx.req.user!.roles, ['ADMIN']) && p.cashierId === ctx.req.user!.id;
  if (original.sessionId !== session.id && !adminAtTill) {
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
    createdAt: recordedNow,
  });
  await tx.insert(saleLine).values(
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
    await tx.insert(walletEntry).values({
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
    ...asCashier(ctx, p),
    before: { number: original.number, total: original.total },
    after: { cancelledBy: number, reason: p.reason ?? null, cashierCheck },
  });
  return number;
}

// --- Top-up at the till (R-CAG-01, R-CAG-06) -----------------------------------------

async function topup(ctx: Ctx, p: Extract<SyncOp, { kind: 'WALLET_TOPUP' }>['payload']) {
  const { tx } = ctx;
  const session = await sessionOf(ctx, p.sessionId, new Date(p.at));
  const cashierCheck = await noteCashier(ctx, p);
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
      createdAt: recordedNow,
    })
    .returning({ id: memberPayment.id });
  await tx.insert(walletEntry).values({
    householdId: h.id,
    at,
    amount: p.amount,
    kind: 'TOPUP',
    paymentMethod: p.method,
    paymentId: pay!.id,
    createdBy: p.cashierId,
  });
  await audit(tx, ctx.req, {
    action: 'wallet.topup',
    entity: 'household',
    entityId: h.id,
    ...asCashier(ctx, p),
    before: { balanceCents: before },
    after: { amount: p.amount, method: p.method, at: 'caisse', paymentId: pay!.id, cashierCheck },
  });
  // R-EVO-40: the top-up receipt is automatic too (opt-out respected).
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
  if (to?.email && !to.ticketEmailOptOut)
    await queueEmail(tx, topupReceiptEmail(to.email, to.firstName, r));
}
