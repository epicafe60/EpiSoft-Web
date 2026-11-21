import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { household, member, membershipType, product, walletEntry } from '@episoft/db';
import { toShopDate } from '../src/lib/dates';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// R-CPT-20: the extract of the accounting allocations (Accounting › Editions).

type SyncOp = Parameters<Till['push']>[0][number];
type Report = {
  title: string;
  subtitle?: string;
  columns: { key: string; label: string }[];
  rows: { cells: Record<string, string | null>; bold?: boolean }[];
};

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
let compta: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
  compta = await login(t.app, (await createUser(t.db, { roles: ['COMPTA'] })).username!);
});

async function addHousehold() {
  const [h] = await t.db.insert(household).values({}).returning();
  const [m] = await t.db
    .insert(member)
    .values({ firstName: 'Anne', lastName: 'FOYER', householdId: h!.id, status: 'ACTIVE' })
    .returning();
  await t.db.update(household).set({ referentMemberId: m!.id }).where(eq(household.id, h!.id));
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

const today = () => toShopDate(new Date());
const get = (query: string, headers = compta) =>
  t.app.inject({ url: `/api/v1/reports/allocations?${query}`, headers });

describe('GET /reports/allocations (R-CPT-20)', () => {
  it('lists tickets and payments with don, adhésion, cagnotte and purchase, and adds them up', async () => {
    const goods = await addProduct(t.db, { salePrice: '2.50' });
    const [don] = await t.db.select().from(product).where(eq(product.code, '01004'));
    const [annual] = await t.db
      .select()
      .from(membershipType)
      .where(eq(membershipType.code, 'ANNUAL'));
    const { householdId, memberId } = await addHousehold();
    await t.db.insert(walletEntry).values({ householdId, amount: '20.00', kind: 'CORRECTION' });

    // A: cash ticket without a member. B: goods + donation + membership, 10 from the cagnotte, 6 in
    // cash with 4 of change into it. C: card ticket, cancelled afterwards.
    const a = sale(
      [{ productId: goods.id, unitPrice: '2.50' }],
      [{ method: 'CASH', amount: '2.50' }],
    );
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
    const c = sale(
      [{ productId: goods.id, unitPrice: '2.50' }],
      [{ method: 'CARD', amount: '2.50' }],
    );
    for (const op of [a, b, c]) expect((await till.push([op]))[0]!.status).toBe('OK');
    expect((await till.push([cancelOp(c.id)]))[0]!.status).toBe('OK');
    // Payments made outside a ticket, and a cagnotte debit that belongs to no ticket.
    await t.db
      .execute(sql`insert into app.member_payment (id, household_id, date, amount, purpose, method, cash_session_id, created_by)
      values (gen_random_uuid(), ${householdId}, current_date, 12, 'MEMBERSHIP', 'CASH', ${till.sessionId}, ${till.cashierId}),
             (gen_random_uuid(), ${householdId}, current_date, 3, 'DONATION', 'CARD', ${till.sessionId}, ${till.cashierId})`);
    await t.db
      .insert(walletEntry)
      .values({ householdId, amount: '-7.40', kind: 'PURCHASE', comment: 'Reprise' });

    const res = await get(`from=${today()}&to=${today()}`);
    expect(res.statusCode).toBe(200);
    const r = res.json() as Report;
    expect(r.title).toBe('Allocations comptables');
    expect(r.columns.map((x) => x.label)).toEqual([
      'Date d’opération',
      'Libellé Ticket',
      'Nom Adhérent (ou adhérent de passage)',
      'Mode de règlement',
      'Montant DON',
      'Montant ADHESION (ou adhésion de passage)',
      'Montant Versement sur CAGNOTTE',
      'Montant ACHAT',
      'Total Montant Ticket',
      'Contrôle (I = E+F+H)',
      'Remarque',
    ]);
    const numberA = await numberOf(a.id);
    const numberB = await numberOf(b.id);
    const body = r.rows.filter((x) => !x.bold).map((x) => x.cells);
    // A, B, two payments, the debit and the opening correction: the cancelled ticket C is left out.
    expect(body).toHaveLength(6);
    expect(body.find((x) => x.label === 'Correction de cagnotte')).toMatchObject({
      cag: '20.00',
      total: '0.00',
    });

    const ticketA = body.find((x) => x.label === `Ticket n° ${numberA}`)!;
    expect(ticketA).toMatchObject({
      who: 'Adhérent de passage',
      mode: 'Espèces',
      achat: '2.50',
      total: '2.50',
    });
    const ticketB = body.find((x) => x.label === `Ticket n° ${numberB}`)!;
    expect(ticketB).toMatchObject({
      who: 'Anne FOYER',
      don: '1.50',
      adh: '12.00',
      cag: '4.00',
      achat: '2.50',
      total: '16.00',
      check: '0.00',
    });
    expect(ticketB.mode).toMatch(/Espèces.*Cagnotte|Cagnotte.*Espèces/);
    expect(body.find((x) => x.label === 'Adhésion')).toMatchObject({
      adh: '12.00',
      total: '12.00',
      mode: 'Espèces',
    });
    expect(body.find((x) => x.label === 'Don')).toMatchObject({
      don: '3.00',
      total: '3.00',
      mode: 'Carte',
    });
    expect(body.find((x) => x.label === 'Achats réglés par la cagnotte')).toMatchObject({
      achat: '7.40',
      mode: 'Cagnotte',
    });

    // The last line adds up; every control is zero.
    const total = r.rows.at(-1)!;
    expect(total.bold).toBe(true);
    expect(total.cells).toMatchObject({
      label: 'Total',
      don: '4.50',
      adh: '24.00',
      cag: '24.00',
      achat: '12.40',
      total: '40.90',
    });
    expect(body.every((x) => x.check === '0.00')).toBe(true);
    expect(r.subtitle).toContain('1 ticket(s) annulé(s)');
  });

  it('includes the payments entered outside a till, by their own date (no cash session)', async () => {
    const { householdId } = await addHousehold();
    // Entered at the back office, or taken over from the previous software: no cash session.
    await t.db
      .execute(sql`insert into app.member_payment (id, household_id, date, amount, purpose, method, created_by)
      values (gen_random_uuid(), ${householdId}, '2026-02-10', 150, 'TOPUP', 'TRANSFER', ${till.cashierId}),
             (gen_random_uuid(), ${householdId}, '2026-02-11', 12, 'MEMBERSHIP', 'CHEQUE', ${till.cashierId}),
             (gen_random_uuid(), ${householdId}, '2026-03-05', 38, 'DONATION', 'CASH', ${till.cashierId})`);
    const r = (await get('from=2026-02-01&to=2026-02-28')).json() as Report;
    const body = r.rows.filter((x) => !x.bold).map((x) => x.cells);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      date: '10/02/2026',
      label: 'Versement sur cagnotte',
      mode: 'Virement',
      cag: '150.00',
      total: '0.00',
    });
    expect(body[1]).toMatchObject({
      date: '11/02/2026',
      label: 'Adhésion',
      mode: 'Chèque',
      adh: '12.00',
      total: '12.00',
    });
    // The donation of March is outside the period.
    expect(r.rows.at(-1)!.cells).toMatchObject({
      cag: '150.00',
      adh: '12.00',
      don: '0.00',
      total: '12.00',
    });
  });

  it('refuses a missing or reversed period, and is reserved to the accountants', async () => {
    expect((await get('')).statusCode).toBe(400);
    expect((await get(`from=${today()}`)).statusCode).toBe(400);
    const reversed = await get('from=2026-05-02&to=2026-05-01');
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().errors[0].path).toBe('to');
    expect((await get(`from=${today()}&to=${today()}`, till.cashier)).statusCode).toBe(403);
  });

  it('is an Excel file with the columns of the template, numbers as numbers', async () => {
    const goods = await addProduct(t.db, { salePrice: '2.50' });
    await till.push([
      sale([{ productId: goods.id, unitPrice: '2.50' }], [{ method: 'CASH', amount: '2.50' }]),
    ]);
    const res = await get(`from=${today()}&to=${today()}&format=xlsx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('allocations-');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe('Allocations comptables');
    expect(ws.getRow(1).getCell(1).value).toBe('Date d’opération');
    expect(ws.getRow(2).getCell(8).value).toBe(2.5);
    expect(ws.getRow(2).getCell(9).value).toBe(2.5);
    // The same figures as the screen.
    const json = (await get(`from=${today()}&to=${today()}`)).json() as Report;
    expect(json.rows).toHaveLength(2);
  });
});

async function numberOf(saleId: string): Promise<string> {
  const rows = await t.db.execute<{ number: string }>(
    sql`select number from app.sale where id = ${saleId}`,
  );
  return rows.rows[0]!.number;
}
