import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  cashSession,
  household,
  memberPayment,
  membershipType,
  posDevice,
  product,
  sale,
  saleLine,
  salePayment,
  walletEntry,
  type DbOrTx,
} from '@episoft/db';
import {
  centsToDecimal,
  decimalToCents,
  DONATION_PRODUCT_CODE,
  operationTypeOfPurpose,
  sortOperations,
  type OperationRow,
  type PaymentMethod,
} from '@episoft/shared';

const PARIS_DAY = (col: SQL) => sql`(${col} at time zone 'Europe/Paris')::date`;

/**
 * The operations of a session, or of a day (Paris time, every till): one row per ticket and one per
 * payment made outside a ticket. A cancelled ticket is kept (struck through in the screen, left out
 * of the totals); the cancellation tickets are not listed. The change paid into the cagnotte is
 * recorded as a payment tied to its ticket: it belongs to the ticket (`walletCash`).
 */
export async function listOperations(
  db: DbOrTx,
  scope: { sessionId: string } | { day: string },
): Promise<OperationRow[]> {
  const bySession = 'sessionId' in scope;

  // --- Tickets
  const saleScope = bySession
    ? eq(sale.sessionId, scope.sessionId)
    : sql`${PARIS_DAY(sql`${sale.soldAt}`)} = ${scope.day}::date`;
  const sales = await db
    .select({
      id: sale.id,
      number: sale.number,
      soldAt: sale.soldAt,
      total: sale.total,
      status: sale.status,
      cancelled: sql<boolean>`(${sale.status} = 'CANCELLED' or exists (select 1 from app.sale c where c.cancels_sale_id = ${sale.id}))`,
      memberName: sql<
        string | null
      >`(select m.first_name || ' ' || m.last_name from app.member m where m.id = ${sale.memberId})`,
      cashierName: sql<
        string | null
      >`(select c.first_name || ' ' || c.last_name from app.member c where c.id = ${sale.cashierId})`,
      deviceName: posDevice.name,
    })
    .from(sale)
    .leftJoin(posDevice, eq(posDevice.id, sale.deviceId))
    .where(and(isNull(sale.cancelsSaleId), saleScope));
  const ids = sales.map((s) => s.id);

  const [lines, pays, wallets, changes, donations, memberships] = ids.length
    ? await Promise.all([
        db
          .select({
            saleId: saleLine.saleId,
            productId: saleLine.productId,
            total: saleLine.lineTotal,
          })
          .from(saleLine)
          .where(inArray(saleLine.saleId, ids)),
        db.select().from(salePayment).where(inArray(salePayment.saleId, ids)),
        db
          .select({
            saleId: walletEntry.saleId,
            amount: sql<string>`sum(${walletEntry.amount})::numeric(12,2)::text`,
          })
          .from(walletEntry)
          .where(inArray(walletEntry.saleId, ids))
          .groupBy(walletEntry.saleId),
        db
          .select({
            saleId: memberPayment.saleId,
            amount: sql<string>`sum(${memberPayment.amount})::numeric(12,2)::text`,
          })
          .from(memberPayment)
          .where(
            and(
              inArray(memberPayment.saleId, ids),
              eq(memberPayment.purpose, 'TOPUP'),
              eq(memberPayment.method, 'CASH'),
            ),
          )
          .groupBy(memberPayment.saleId),
        db.select({ id: product.id }).from(product).where(eq(product.code, DONATION_PRODUCT_CODE)),
        db.select({ id: membershipType.productId }).from(membershipType),
      ])
    : [[], [], [], [], [], []];
  const donationIds = new Set(donations.map((d) => d.id));
  const membershipIds = new Set(memberships.flatMap((m) => (m.id ? [m.id] : [])));
  const sumLines = (saleId: string, set: Set<string>) =>
    lines
      .filter((l) => l.saleId === saleId && set.has(l.productId))
      .reduce((s, l) => s + decimalToCents(l.total), 0);

  const saleRows: OperationRow[] = sales.map((s) => ({
    id: s.id,
    origin: 'SERVER',
    type: 'SALE',
    at: s.soldAt.toISOString(),
    number: s.number,
    cashierName: s.cashierName,
    deviceName: s.deviceName ?? null,
    memberName: s.memberName,
    payments: pays
      .filter((p) => p.saleId === s.id)
      .map((p) => ({ method: p.method as PaymentMethod, amount: p.amount })),
    total: s.total,
    donation: centsToDecimal(sumLines(s.id, donationIds)),
    membership: centsToDecimal(sumLines(s.id, membershipIds)),
    wallet: wallets.find((w) => w.saleId === s.id)?.amount ?? '0.00',
    walletCash: changes.find((c) => c.saleId === s.id)?.amount ?? '0.00',
    cancelled: s.cancelled,
    sync: 'SENT',
    error: null,
  }));

  // --- Payments made outside a ticket (the change of a ticket is tied to its sale: left out)
  const paymentScope = bySession
    ? eq(memberPayment.cashSessionId, scope.sessionId)
    : sql`${PARIS_DAY(sql`${memberPayment.createdAt}`)} = ${scope.day}::date`;
  const payments = await db
    .select({
      id: memberPayment.id,
      createdAt: memberPayment.createdAt,
      amount: memberPayment.amount,
      purpose: memberPayment.purpose,
      method: memberPayment.method,
      referent: sql<
        string | null
      >`(select r.first_name || ' ' || r.last_name from app.member r where r.id = ${household.referentMemberId})`,
      cashierName: sql<
        string | null
      >`(select c.first_name || ' ' || c.last_name from app.member c where c.id = ${memberPayment.createdBy})`,
      deviceName: posDevice.name,
      cancelled: sql<boolean>`exists (select 1 from app.wallet_entry w
        join app.wallet_entry x on x.cancels_entry_id = w.id where w.payment_id = ${memberPayment.id})`,
    })
    .from(memberPayment)
    .innerJoin(household, eq(household.id, memberPayment.householdId))
    .leftJoin(cashSession, eq(cashSession.id, memberPayment.cashSessionId))
    .leftJoin(posDevice, eq(posDevice.id, cashSession.deviceId))
    .where(and(isNull(memberPayment.saleId), isNotNull(memberPayment.cashSessionId), paymentScope));
  const paymentRows: OperationRow[] = payments.map((p) => ({
    id: p.id,
    origin: 'SERVER',
    type: operationTypeOfPurpose(p.purpose),
    at: p.createdAt.toISOString(),
    number: null,
    cashierName: p.cashierName,
    deviceName: p.deviceName ?? null,
    memberName: p.referent,
    payments: p.method ? [{ method: p.method as PaymentMethod, amount: p.amount }] : [],
    total: p.amount,
    donation: p.purpose === 'DONATION' ? p.amount : '0.00',
    membership: p.purpose === 'MEMBERSHIP' ? p.amount : '0.00',
    wallet: p.purpose === 'TOPUP' ? p.amount : '0.00',
    walletCash: '0.00',
    cancelled: p.cancelled,
    sync: 'SENT',
    error: null,
  }));

  return sortOperations([...saleRows, ...paymentRows]);
}
