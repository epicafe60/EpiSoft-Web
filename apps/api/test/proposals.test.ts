import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  cashSession,
  entry,
  posDevice,
  product,
  sale,
  saleLine,
  salePayment,
  type Db,
} from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

async function resetAccounting(db: Db) {
  await db.execute(sql`truncate app.reconciliation, app.bank_line, app.bank_statement, app.bank_rule, app.bank_account,
    app.cash_deposit, app.entry_template_line, app.entry_template, app.entry_line, app.entry, app.fiscal_year,
    app.invoice_receipt, app.supplier_invoice, app.number_counter cascade`);
}

beforeEach(async () => {
  await t.reset();
  await resetAccounting(t.db);
  const u = await createUser(t.db, { roles: ['COMPTA'] });
  h = await login(t.app, u.username!);
  await t.app.inject({
    method: 'POST',
    url: '/api/v1/fiscal-years',
    headers: h,
    payload: { label: 'Exercice 2026', startDate: '2026-01-01', endDate: '2026-12-31' },
  });
});

const get = (url: string) => t.app.inject({ url: `/api/v1${url}`, headers: h });
const post = (url: string, payload: object) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

let n = 0;
/** A closed session on `day` with one cash sale of `euros`. */
async function sessionWithSale(day: string, euros: string) {
  n++;
  const [dev] = await t.db
    .insert(posDevice)
    .values({ name: `D${n}` })
    .returning();
  const sid = crypto.randomUUID();
  await t.db.insert(cashSession).values({
    id: sid,
    deviceId: dev!.id,
    openedAt: new Date(`${day}T08:00:00Z`),
    closedAt: new Date(`${day}T10:00:00Z`),
    openingFloat: '0',
    status: 'CLOSED',
  });
  await addSale(sid, day, euros);
  return sid;
}
async function addSale(sessionId: string, day: string, euros: string) {
  n++;
  const [p] = await t.db
    .insert(product)
    .values({ code: `P${n}`, name: `Produit ${n}`, salePrice: euros })
    .returning();
  const id = crypto.randomUUID();
  await t.db.insert(sale).values({
    id,
    number: `T-2026-${String(n).padStart(6, '0')}`,
    sessionId,
    soldAt: new Date(`${day}T09:00:00Z`),
    total: euros,
  });
  await t.db.insert(saleLine).values({
    saleId: id,
    lineNo: 1,
    productId: p!.id,
    label: 'x',
    qty: '1',
    unitPrice: euros,
    lineTotal: euros,
  });
  await t.db.insert(salePayment).values({ saleId: id, method: 'CASH', amount: euros });
}

type Prop = { key: string; sessions: number; total: string; state: string };

describe('entries proposed from the cash sessions (R-CPT-08)', () => {
  it('balances the entry with a visible adjustment when a ticket’s lines differ from what was paid', async () => {
    const sid = await sessionWithSale('2026-07-06', '10.00');
    // A migrated ticket: 12 € paid in cash but its lines only add up to 10 €.
    n++;
    const [p] = await t.db
      .insert(product)
      .values({ code: `P${n}`, name: `Produit ${n}`, salePrice: '10' })
      .returning();
    const id = crypto.randomUUID();
    await t.db.insert(sale).values({
      id,
      number: `T-2026-${String(n).padStart(6, '0')}`,
      sessionId: sid,
      soldAt: new Date('2026-07-06T09:30:00Z'),
      total: '12.00',
    });
    await t.db.insert(saleLine).values({
      saleId: id,
      lineNo: 1,
      productId: p!.id,
      label: 'x',
      qty: '1',
      unitPrice: '10',
      lineTotal: '10.00',
    });
    await t.db.insert(salePayment).values({ saleId: id, method: 'CASH', amount: '12.00' });

    const body = { from: '2026-07-01', to: '2026-07-31', grouping: 'WEEK' };
    const prop = (await get('/accounting/proposals?from=2026-07-01&to=2026-07-31')).json()
      .proposals[0];
    expect(prop).toMatchObject({ total: '22.00', adjustment: '2.00' });
    const gen = await post('/accounting/proposals/generate', { ...body, keys: [prop.key] });
    expect(gen.statusCode).toBe(200);
    expect(gen.json()).toMatchObject({ created: 1 });
  });

  it('proposes one draft per week, then keeps it current when the sales change', async () => {
    const s1 = await sessionWithSale('2026-07-06', '10.00'); // Monday
    await sessionWithSale('2026-07-08', '10.00'); // same week
    await sessionWithSale('2026-07-13', '5.00'); // next week
    const range = 'from=2026-07-01&to=2026-07-31&grouping=WEEK';
    const body = { from: '2026-07-01', to: '2026-07-31', grouping: 'WEEK' };

    const first = (await get(`/accounting/proposals?${range}`)).json();
    expect(first.proposals.map((p: Prop) => [p.sessions, p.total])).toEqual([
      [2, '20.00'],
      [1, '5.00'],
    ]);
    expect(first.proposals[0]).toMatchObject({ state: 'NEW', entryDate: '2026-07-08' });
    const credit = first.proposals[0].lines.find((l: { credit: string }) => l.credit === '20.00');
    expect(credit.account).toBe('707000');

    const keys = first.proposals.map((p: Prop) => p.key);
    const gen = await post('/accounting/proposals/generate', { ...body, keys });
    expect(gen.json()).toMatchObject({ created: 2, updated: 0 });
    expect(await t.db.select().from(entry).where(eq(entry.status, 'DRAFT'))).toHaveLength(2);

    // Nothing changed: nothing to do.
    const again = (await get(`/accounting/proposals?${range}`)).json();
    expect(again.proposals.map((p: Prop) => p.state)).toEqual(['UP_TO_DATE', 'UP_TO_DATE']);

    // A late sale in an already generated week: the draft is to be refreshed.
    await addSale(s1, '2026-07-06', '10.00');
    const changed = (await get(`/accounting/proposals?${range}`)).json();
    expect(changed.proposals[0]).toMatchObject({
      state: 'OUTDATED_DRAFT',
      total: '30.00',
      existingTotal: '20.00',
    });
    const upd = await post('/accounting/proposals/generate', {
      ...body,
      keys: [changed.proposals[0].key],
    });
    expect(upd.json()).toMatchObject({ created: 0, updated: 1 });
    const after = (await get(`/accounting/proposals?${range}`)).json();
    expect(after.proposals[0].state).toBe('UP_TO_DATE');
  });

  it('never touches a validated entry, and proposes again when a draft is deleted', async () => {
    const s1 = await sessionWithSale('2026-07-06', '10.00');
    const range = 'from=2026-07-01&to=2026-07-31&grouping=WEEK';
    const body = { from: '2026-07-01', to: '2026-07-31', grouping: 'WEEK' };
    const p = (await get(`/accounting/proposals?${range}`)).json().proposals[0] as Prop;
    await post('/accounting/proposals/generate', { ...body, keys: [p.key] });

    const [e] = await t.db.select().from(entry);
    await post('/entries/validate', { ids: [e!.id] });
    await addSale(s1, '2026-07-06', '4.00');
    const diff = (await get(`/accounting/proposals?${range}`)).json().proposals[0] as Prop;
    expect(diff.state).toBe('DIFFERS_VALIDATED');
    const res = await post('/accounting/proposals/generate', { ...body, keys: [diff.key] });
    expect(res.json()).toMatchObject({ created: 0, updated: 0, skipped: [diff.key] });
    expect((await t.db.select().from(entry))[0]!.status).toBe('VALIDATED');

    // Cancelling (deleting) a draft brings its proposal back.
    await sessionWithSale('2026-07-20', '7.00');
    const next = (await get(`/accounting/proposals?${range}`)).json().proposals.at(-1) as Prop;
    await post('/accounting/proposals/generate', { ...body, keys: [next.key] });
    const draft = (await t.db.select().from(entry).where(eq(entry.status, 'DRAFT')))[0]!;
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/entries/${draft.id}`,
      headers: h,
    });
    expect(del.statusCode).toBe(204);
    const back = (await get(`/accounting/proposals?${range}`)).json().proposals.at(-1) as Prop;
    expect(back).toMatchObject({ key: next.key, state: 'NEW' });
  });

  it('starts after the last manual sales entry; the start date stays editable', async () => {
    await sessionWithSale('2026-07-02', '10.00');
    await sessionWithSale('2026-07-08', '10.00');
    // An entry of the old accounting (no source) on 03/07.
    const vte = (await get('/journals')).json().find((j: { code: string }) => j.code === 'VTE');
    const a1 = (await t.db.select().from(account).where(eq(account.number, '512001')))[0]!;
    const a2 = (await t.db.select().from(account).where(eq(account.number, '707000')))[0]!;
    await post('/entries', {
      journalId: vte.id,
      date: '2026-07-03',
      pieceRef: null,
      label: 'Ventes Semaine 27',
      mode: null,
      lines: [
        { accountId: a1.id, label: '', debit: '10', credit: '' },
        { accountId: a2.id, label: '', debit: '', credit: '10' },
      ],
    });

    const auto = (await get('/accounting/proposals?to=2026-07-31')).json();
    expect(auto.defaultFrom).toBe('2026-07-04');
    expect(auto.from).toBe('2026-07-04');
    expect(auto.proposals).toHaveLength(1); // the session of the 2nd is before the start
    expect(auto.overlappingEntries).toBe(0);

    // Going back before the old entry is allowed, with a warning about counting twice.
    const manual = (await get('/accounting/proposals?from=2026-07-01&to=2026-07-31')).json();
    expect(manual.proposals).toHaveLength(2);
    expect(manual.overlappingEntries).toBe(1);
  });
});
