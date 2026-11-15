import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { household, member, membershipType, product, walletEntry } from '@episoft/db';
import { operationTotals, type OperationRow, type SyncOp } from '@episoft/shared';
import { setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// « Opérations du jour »: one row per ticket and per payment made outside a ticket.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});

async function addHousehold(balance = '0') {
  const [h] = await t.db.insert(household).values({}).returning();
  const [m] = await t.db
    .insert(member)
    .values({ firstName: 'Anne', lastName: 'FOYER', householdId: h!.id, status: 'ACTIVE' })
    .returning();
  await t.db.update(household).set({ referentMemberId: m!.id }).where(eq(household.id, h!.id));
  if (balance !== '0')
    await t.db
      .insert(walletEntry)
      .values({ householdId: h!.id, amount: balance, kind: 'CORRECTION' });
  return { householdId: h!.id, memberId: m!.id };
}

function sale(
  lines: { productId: string; unitPrice: string }[],
  payments: object[],
  memberId: string | null = null,
): Extract<SyncOp, { kind: 'SALE' }> {
  const op = till.saleOp(lines, '0');
  if (op.kind !== 'SALE') throw new Error('sale expected');
  return { ...op, payload: { ...op.payload, memberId, payments: payments as never } };
}

const cancelOp = (saleId: string): SyncOp => {
  const n = till.nextSeq();
  return {
    kind: 'SALE_CANCEL',
    id: randomUUID(),
    deviceSeq: n,
    payload: {
      cancelSaleId: randomUUID(),
      saleId,
      sessionId: till.sessionId,
      cashierId: till.cashierId,
      at: new Date().toISOString(),
      provisionalNumber: `CAISSE1-${n}`,
    },
  };
};

const topupOp = (householdId: string, amount: string, method: 'CASH' | 'CHEQUE'): SyncOp => ({
  kind: 'WALLET_TOPUP',
  id: randomUUID(),
  deviceSeq: till.nextSeq(),
  payload: {
    sessionId: till.sessionId,
    cashierId: till.cashierId,
    householdId,
    amount,
    method,
    at: new Date().toISOString(),
    emailReceipt: false,
  },
});

const read = async (query: string) => {
  const res = await t.app.inject({ url: `/api/v1/pos/operations?${query}`, headers: till.cashier });
  expect(res.statusCode).toBe(200);
  return res.json() as OperationRow[];
};

describe('GET /pos/operations (R-VTE-12, R-CAG-05, R-SES-02)', () => {
  it('lists tickets and payments with don, adhésion and cagnotte, and adds up like the closing', async () => {
    const goods = await addProduct(t.db, { salePrice: '2.50' });
    const [don] = await t.db.select().from(product).where(eq(product.code, '01004'));
    const [annual] = await t.db
      .select()
      .from(membershipType)
      .where(eq(membershipType.code, 'ANNUAL'));
    const { householdId, memberId } = await addHousehold('20.00');

    // A: cash ticket with no member.
    const a = sale(
      [{ productId: goods.id, unitPrice: '2.50' }],
      [{ method: 'CASH', amount: '2.50' }],
    );
    // B: goods + donation + membership, 10 from the cagnotte, 6 in cash with 4 of change into it.
    const b = sale(
      [
        { productId: goods.id, unitPrice: '2.50' },
        { productId: don!.id, unitPrice: '1.50' },
        { productId: annual!.productId!, unitPrice: '12.00' },
      ],
      [
        { method: 'WALLET', amount: '10.00' },
        { method: 'CASH', amount: '6.00', tendered: '10.00', change: '4.00', changeToWallet: true },
      ],
      memberId,
    );
    // C: a card ticket, cancelled afterwards.
    const c = sale(
      [{ productId: goods.id, unitPrice: '2.50' }],
      [{ method: 'CARD', amount: '2.50' }],
    );
    for (const op of [a, b, c, topupOp(householdId, '20.00', 'CHEQUE')]) {
      expect((await till.push([op]))[0]!.status).toBe('OK');
    }
    expect((await till.push([cancelOp(c.id)]))[0]!.status).toBe('OK');
    // Payments made outside a ticket and outside the till's queue (back office style).
    await t.db
      .execute(sql`insert into app.member_payment (id, household_id, date, amount, purpose, method, cash_session_id, created_by)
      values (gen_random_uuid(), ${householdId}, current_date, 12, 'MEMBERSHIP', 'CASH', ${till.sessionId}, ${till.cashierId}),
             (gen_random_uuid(), ${householdId}, current_date, 3, 'DONATION', 'CARD', ${till.sessionId}, ${till.cashierId})`);

    const rows = await read(`sessionId=${till.sessionId}`);
    // 3 tickets (the cancellation ticket is not listed) + 1 top-up + 2 payments; the change is not a row.
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.type === 'SALE')).toHaveLength(3);

    const rowB = rows.find((r) => r.id === b.id)!;
    expect(rowB).toMatchObject({
      type: 'SALE',
      origin: 'SERVER',
      total: '16.00',
      donation: '1.50',
      membership: '12.00',
      wallet: '-6.00',
      walletCash: '4.00',
      cancelled: false,
      memberName: 'Anne FOYER',
      cashierName: till.cashierName,
      deviceName: 'CAISSE1',
    });
    expect(rowB.payments).toEqual(
      expect.arrayContaining([
        { method: 'WALLET', amount: '10.00' },
        { method: 'CASH', amount: '6.00' },
      ]),
    );
    expect(rows.find((r) => r.id === c.id)!.cancelled).toBe(true);
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ donation: '0.00', wallet: '0.00' });

    const topup = rows.find((r) => r.type === 'TOPUP')!;
    expect(topup).toMatchObject({
      total: '20.00',
      wallet: '20.00',
      memberName: 'Anne FOYER',
      cashierName: till.cashierName,
      payments: [{ method: 'CHEQUE', amount: '20.00' }],
    });
    expect(rows.find((r) => r.type === 'MEMBERSHIP_PAYMENT')).toMatchObject({
      total: '12.00',
      membership: '12.00',
      wallet: '0.00',
    });
    expect(rows.find((r) => r.type === 'DONATION_PAYMENT')).toMatchObject({ donation: '3.00' });
    // Most recent first.
    const ats = rows.map((r) => r.at);
    expect(ats).toEqual([...ats].sort().reverse());

    // The totals are the closing's (cancelled ticket left out, change counted as cash).
    const totals = operationTotals(rows);
    expect(totals).toMatchObject({
      count: 5,
      sales: '18.50',
      payments: '35.00',
      donation: '4.50',
      membership: '24.00',
      wallet: '14.00',
    });
    const summary = (
      await t.app.inject({
        url: `/api/v1/pos/sessions/${till.sessionId}/summary`,
        headers: till.cashier,
      })
    ).json();
    expect(totals.byMethod.CASH).toBe(
      (Number(summary.cashSales) + Number(summary.cashOther)).toFixed(2),
    );
    expect(totals.byMethod.CHEQUE).toBe(summary.chequesComputed);
    expect(totals.byMethod.CARD).toBe(summary.cardComputed);
    expect(totals.byMethod.WALLET).toBe(summary.byMethod.WALLET);

    // The whole day gives the same rows, whichever session.
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    expect((await read(`day=${today}`)).map((r) => r.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );
  });

  it('keeps the change paid into the cagnotte as a top-up when its ticket is cancelled', async () => {
    const goods = await addProduct(t.db, { salePrice: '6.00' });
    const { memberId } = await addHousehold();
    const d = sale(
      [{ productId: goods.id, unitPrice: '6.00' }],
      [{ method: 'CASH', amount: '6.00', tendered: '10.00', change: '4.00', changeToWallet: true }],
      memberId,
    );
    expect((await till.push([d]))[0]!.status).toBe('OK');
    expect((await till.push([cancelOp(d.id)]))[0]!.status).toBe('OK');

    const rows = await read(`sessionId=${till.sessionId}`);
    expect(rows.find((r) => r.id === d.id)).toMatchObject({ cancelled: true, walletCash: '0.00' });
    expect(rows.find((r) => r.id === `${d.id}:change`)).toMatchObject({
      type: 'TOPUP',
      cancelled: false,
      total: '4.00',
      wallet: '4.00',
      payments: [{ method: 'CASH', amount: '4.00' }],
    });
    // Only the top-up is left in the totals, and it matches the closing.
    const totals = operationTotals(rows);
    expect(totals).toMatchObject({ count: 1, sales: '0.00', payments: '4.00', wallet: '4.00' });
    const summary = (
      await t.app.inject({
        url: `/api/v1/pos/sessions/${till.sessionId}/summary`,
        headers: till.cashier,
      })
    ).json();
    expect(totals.byMethod.CASH).toBe(
      (Number(summary.cashSales) + Number(summary.cashOther)).toFixed(2),
    );
  });

  it('marks a payment cancelled when its cagnotte entry is cancelled, and asks for a scope', async () => {
    const { householdId } = await addHousehold();
    expect((await till.push([topupOp(householdId, '15.00', 'CASH')]))[0]!.status).toBe('OK');
    await t.db
      .execute(sql`insert into app.wallet_entry (id, household_id, amount, kind, cancels_entry_id)
      select gen_random_uuid(), household_id, -amount, 'CORRECTION', id from app.wallet_entry where kind = 'TOPUP'`);
    const rows = await read(`sessionId=${till.sessionId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'TOPUP', cancelled: true });
    expect(operationTotals(rows).byMethod.CASH).toBe('0.00');
    const res = await t.app.inject({ url: '/api/v1/pos/operations', headers: till.cashier });
    expect(res.statusCode).toBe(400);
  });
});
