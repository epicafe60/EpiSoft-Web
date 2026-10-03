import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  cashSession,
  memberPayment,
  sale,
  salePayment,
  membership,
  type DbOrTx,
} from '@episoft/db';
import {
  centsToDecimal,
  decimalToCents,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '@episoft/shared';

export interface SessionSummary {
  sessionId: string;
  openingFloat: string;
  salesCount: number;
  cancellationsCount: number;
  salesTotal: string;
  /** Net sale payments by method (cancellations subtracted). */
  byMethod: Record<PaymentMethod, string>;
  /** Payments outside sales (top-ups, memberships, donations), by purpose and method. */
  other: { purpose: string; method: PaymentMethod | null; amount: string }[];
  membershipsCount: number;
  cashSales: string;
  cashOther: string;
  chequesComputed: string;
  cardComputed: string;
}

/** R-SES-02 step 2: totals of a session, by payment method and category. */
export async function sessionSummary(db: DbOrTx, sessionId: string): Promise<SessionSummary> {
  const s = await db.query.cashSession.findFirst({ where: eq(cashSession.id, sessionId) });
  if (!s) throw new Error('session not found');

  const [counts] = await db
    .select({
      sales: sql<number>`count(*) filter (where ${sale.cancelsSaleId} is null)::int`,
      cancellations: sql<number>`count(*) filter (where ${sale.cancelsSaleId} is not null)::int`,
      total: sql<string>`coalesce(sum(${sale.total}), 0)::numeric(12,2)::text`,
    })
    .from(sale)
    .where(eq(sale.sessionId, sessionId));

  const pays = await db
    .select({
      method: salePayment.method,
      amount: sql<string>`sum(${salePayment.amount})::numeric(12,2)::text`,
    })
    .from(salePayment)
    .innerJoin(sale, eq(sale.id, salePayment.saleId))
    .where(eq(sale.sessionId, sessionId))
    .groupBy(salePayment.method);
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, '0.00'])) as Record<
    PaymentMethod,
    string
  >;
  for (const p of pays) byMethod[p.method] = p.amount;

  const other = await db
    .select({
      purpose: memberPayment.purpose,
      method: memberPayment.method,
      amount: sql<string>`sum(${memberPayment.amount})::numeric(12,2)::text`,
    })
    .from(memberPayment)
    .where(eq(memberPayment.cashSessionId, sessionId))
    .groupBy(memberPayment.purpose, memberPayment.method);

  const [ms] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(membership)
    .innerJoin(sale, eq(sale.id, membership.saleId))
    .where(and(eq(sale.sessionId, sessionId), isNotNull(membership.saleId)));

  const sumOther = (method: PaymentMethod) =>
    other.filter((o) => o.method === method).reduce((t, o) => t + decimalToCents(o.amount), 0);

  return {
    sessionId,
    openingFloat: s.openingFloat,
    salesCount: counts!.sales,
    cancellationsCount: counts!.cancellations,
    salesTotal: counts!.total,
    byMethod,
    other: other.map((o) => ({ ...o, method: o.method as PaymentMethod | null })),
    membershipsCount: ms!.n,
    cashSales: byMethod.CASH,
    cashOther: centsToDecimal(sumOther('CASH')),
    chequesComputed: centsToDecimal(decimalToCents(byMethod.CHEQUE) + sumOther('CHEQUE')),
    cardComputed: centsToDecimal(decimalToCents(byMethod.CARD) + sumOther('CARD')),
  };
}
