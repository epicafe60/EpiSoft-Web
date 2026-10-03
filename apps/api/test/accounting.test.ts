import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, entry, entryLine, supplierInvoice, type Db } from '@episoft/db';
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
  await db.execute(sql`delete from app.supplier`);
}

beforeEach(async () => {
  await t.reset();
  await resetAccounting(t.db);
  const u = await createUser(t.db, { roles: ['COMPTA', 'APPROS'] });
  h = await login(t.app, u.username!);
});

const post = (url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, headers: h, payload: payload as object });
const put = (url: string, payload: unknown) =>
  t.app.inject({ method: 'PUT', url, headers: h, payload: payload as object });
const get = (url: string) => t.app.inject({ url, headers: h });

const acct = async (number: string) =>
  (await t.db.select().from(account).where(eq(account.number, number)))[0]!;
const journalId = async (code: string) =>
  (await get('/api/v1/journals')).json().find((j: { code: string }) => j.code === code)
    .id as string;

async function year2026() {
  const res = await post('/api/v1/fiscal-years', {
    label: 'Exercice 2026',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  expect(res.statusCode).toBe(200);
}

async function entryBody(over: Record<string, unknown> = {}) {
  return {
    journalId: await journalId('OD'),
    date: '2026-03-15',
    pieceRef: 'P1',
    label: 'Régularisation',
    mode: null,
    lines: [
      { accountId: (await acct('607000')).id, label: '', debit: '25,50', credit: '' },
      { accountId: (await acct('512001')).id, label: '', debit: '', credit: '25.50' },
    ],
    ...over,
  };
}

describe('fiscal years (R-CPT-03)', () => {
  it('refuses overlapping years', async () => {
    await year2026();
    const res = await post('/api/v1/fiscal-years', {
      label: 'Autre',
      startDate: '2026-06-01',
      endDate: '2027-05-31',
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('entries (R-CPT-04, R-CPT-05)', () => {
  it('creates a draft, refuses unbalanced, undated-year and unknown-account entries', async () => {
    expect((await post('/api/v1/entries', await entryBody())).statusCode).toBe(400); // no fiscal year yet
    await year2026();
    const ok = await post('/api/v1/entries', await entryBody());
    expect(ok.statusCode).toBe(200);
    const d = (await get(`/api/v1/entries/${ok.json().id}`)).json();
    expect(d).toMatchObject({ status: 'DRAFT', number: null, displayNumber: null });
    expect(
      d.lines.map((l: { accountNumber: string; debit: string; credit: string }) => [
        l.accountNumber,
        l.debit,
        l.credit,
      ]),
    ).toEqual([
      ['607000', '25.50', '0.00'],
      ['512001', '0.00', '25.50'],
    ]);

    const lines = (await entryBody()).lines;
    const unbalanced = await post(
      '/api/v1/entries',
      await entryBody({ lines: [lines[0], { ...lines[1], credit: '25.49' }] }),
    );
    expect(unbalanced.statusCode).toBe(400);
    expect(unbalanced.json().detail).toMatch(/déséquilibrée/);
    const bothSides = await post(
      '/api/v1/entries',
      await entryBody({ lines: [{ ...lines[0], credit: '1' }, lines[1]] }),
    );
    expect(bothSides.statusCode).toBe(400);
    const unknown = await post(
      '/api/v1/entries',
      await entryBody({
        lines: [{ ...lines[0], accountId: '01900000-0000-7000-8000-000000000000' }, lines[1]],
      }),
    );
    expect(unknown.statusCode).toBe(400);
  });

  it('CA: a validated entry cannot be modified or deleted (409) nor by SQL', async () => {
    await year2026();
    const { id } = (await post('/api/v1/entries', await entryBody())).json();
    const v = (await post('/api/v1/entries/validate', { ids: [id] })).json();
    expect(v).toEqual({ validated: 1, numbers: ['OD-2026-0001'] });

    expect(
      (await put(`/api/v1/entries/${id}`, await entryBody({ label: 'autre' }))).statusCode,
    ).toBe(409);
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/v1/entries/${id}`, headers: h }))
        .statusCode,
    ).toBe(409);

    // The database refuses it too, whatever the application does.
    const refused = { cause: { message: expect.stringMatching(/validated/) } };
    await expect(
      t.db.update(entry).set({ label: 'x' }).where(eq(entry.id, id)),
    ).rejects.toMatchObject(refused);
    await expect(t.db.delete(entry).where(eq(entry.id, id))).rejects.toMatchObject(refused);
    await expect(
      t.db.update(entryLine).set({ debit: '99' }).where(eq(entryLine.entryId, id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/validated/) } });
    await expect(t.db.delete(entryLine).where(eq(entryLine.entryId, id))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/validated/) },
    });
  });

  it('numbers continuously per journal and year, in date order, at validation', async () => {
    await year2026();
    const a = (await post('/api/v1/entries', await entryBody({ date: '2026-05-01' }))).json().id;
    const b = (await post('/api/v1/entries', await entryBody({ date: '2026-02-01' }))).json().id;
    const c = (
      await post('/api/v1/entries', await entryBody({ journalId: await journalId('VTE') }))
    ).json().id;
    const v = (await post('/api/v1/entries/validate', { ids: [a, b, c] })).json();
    expect(v.numbers.sort()).toEqual(['OD-2026-0001', 'OD-2026-0002', 'VTE-2026-0001']);
    expect((await get(`/api/v1/entries/${b}`)).json().displayNumber).toBe('OD-2026-0001');
    expect((await get(`/api/v1/entries/${a}`)).json().displayNumber).toBe('OD-2026-0002');
  });

  it('validates by period', async () => {
    await year2026();
    await post('/api/v1/entries', await entryBody({ date: '2026-02-01' }));
    await post('/api/v1/entries', await entryBody({ date: '2026-09-01' }));
    const v = (
      await post('/api/v1/entries/validate', { from: '2026-01-01', to: '2026-06-30' })
    ).json();
    expect(v.validated).toBe(1);
    const left = (await get('/api/v1/entries?status=DRAFT')).json();
    expect(left).toHaveLength(1);
  });

  it('reverses a validated entry once, and the reversal is validated', async () => {
    await year2026();
    const { id } = (await post('/api/v1/entries', await entryBody())).json();
    expect((await post(`/api/v1/entries/${id}/reverse`)).statusCode).toBe(409); // still a draft
    await post('/api/v1/entries/validate', { ids: [id] });
    const rev = await post(`/api/v1/entries/${id}/reverse`, { date: '2026-03-20' });
    expect(rev.statusCode).toBe(200);
    const d = (await get(`/api/v1/entries/${rev.json().id}`)).json();
    expect(d).toMatchObject({
      status: 'VALIDATED',
      reversesEntryId: id,
      displayNumber: 'OD-2026-0002',
    });
    expect(d.lines[0]).toMatchObject({ accountNumber: '607000', debit: '0.00', credit: '25.50' });
    expect((await post(`/api/v1/entries/${id}/reverse`)).statusCode).toBe(409);
  });

  it('duplicates an entry (R-CPT-06)', async () => {
    await year2026();
    const { id } = (await post('/api/v1/entries', await entryBody())).json();
    const copy = (await post(`/api/v1/entries/${id}/duplicate`)).json();
    expect(copy.id).not.toBe(id);
    expect((await get(`/api/v1/entries/${copy.id}`)).json().lines).toHaveLength(2);
  });

  it('refuses entries in a closed fiscal year', async () => {
    await year2026();
    await t.db.execute(sql`update app.fiscal_year set status = 'CLOSED'`);
    expect((await post('/api/v1/entries', await entryBody())).statusCode).toBe(409);
  });
});

describe('chart of accounts (R-CPT-01)', () => {
  it('searches by number or label, refuses to delete a used account', async () => {
    await year2026();
    expect(
      (await get('/api/v1/accounts?q=6070')).json().map((a: { number: string }) => a.number),
    ).toEqual(['607000']);
    expect(
      (await get('/api/v1/accounts?q=cagnotte')).json().map((a: { number: string }) => a.number),
    ).toContain('411000');
    await post('/api/v1/entries', await entryBody());
    const used = await acct('607000');
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/v1/accounts/${used.id}`, headers: h }))
        .statusCode,
    ).toBe(409);
    const created = (
      await post('/api/v1/accounts', {
        number: '606100',
        label: 'Fournitures',
        normalSide: 'D',
        active: true,
      })
    ).json();
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/v1/accounts/${created.id}`, headers: h }))
        .statusCode,
    ).toBe(204);
    expect(
      (await post('/api/v1/accounts', { number: '12', label: 'x', normalSide: 'D', active: true }))
        .statusCode,
    ).toBe(400);
  });
});

describe('supplier invoices → entries (R-FAC-03, R-FAC-04)', () => {
  const supplierForm = {
    region: '07',
    name: 'Ferme du Vexin',
    contact: '',
    street: '',
    postcode: '',
    communeId: null,
    phone: '',
    email: '',
    website: '',
    priceListUrl: '',
    active: true,
    publicNotes: '',
    privateNotes: '',
    referentMemberId: null,
    sendsPo: false,
    accountNumber: '',
    minOrderAmount: null,
    paymentTermsDays: 30,
    deliveryDay: '',
  };

  async function newInvoice() {
    await year2026();
    const s = (await post('/api/v1/suppliers', supplierForm)).json();
    const inv = (
      await post('/api/v1/supplier-invoices', {
        supplierId: s.id,
        pieceRef: 'F-1',
        date: '2026-03-10',
        totalExcl: '240',
        totalVat: '15,64',
        paymentMethod: 'TRANSFER',
        comment: '',
        receiptIds: [],
      })
    ).json();
    return { s, inv };
  }

  it('creates the ACH draft with the TTC on 607000 and 401, refreshes it on edit, pays and letters it', async () => {
    const { s, inv } = await newInvoice();
    const sup = (await get(`/api/v1/suppliers/${s.id}`)).json().accountNumber as string;
    expect(sup).toMatch(/^401[0-9]{3}$/);
    const [row] = await t.db.select().from(supplierInvoice).where(eq(supplierInvoice.id, inv.id));
    const e = (await get(`/api/v1/entries/${row!.entryId}`)).json();
    expect(e).toMatchObject({
      status: 'DRAFT',
      pieceRef: 'F-1',
      date: '2026-03-10',
      journalCode: 'ACH',
    });
    expect(
      e.lines.map((l: { accountNumber: string; debit: string; credit: string }) => [
        l.accountNumber,
        l.debit,
        l.credit,
      ]),
    ).toEqual([
      ['607000', '255.64', '0.00'],
      [sup, '0.00', '255.64'],
    ]);
    expect((await t.db.select().from(account).where(eq(account.number, sup)))[0]!.label).toBe(
      'Ferme du Vexin',
    );

    // Edit: the draft follows.
    await put(`/api/v1/supplier-invoices/${inv.id}`, {
      supplierId: s.id,
      pieceRef: 'F-1',
      date: '2026-03-10',
      totalExcl: '250',
      totalVat: '0',
      paymentMethod: 'TRANSFER',
      comment: '',
      receiptIds: [],
    });
    const [edited] = await t.db
      .select()
      .from(supplierInvoice)
      .where(eq(supplierInvoice.id, inv.id));
    const e2 = (await get(`/api/v1/entries/${edited!.entryId}`)).json();
    expect(e2.lines[0]).toMatchObject({ debit: '250.00' });

    // Payment: 401 debited, 512 credited, same lettering code on the 401 lines.
    const pay = (
      await post(`/api/v1/supplier-invoices/${inv.id}/pay`, {
        date: '2026-03-31',
        method: 'TRANSFER',
      })
    ).json();
    const p = (await get(`/api/v1/entries/${pay.entryId}`)).json();
    expect(p).toMatchObject({ journalCode: 'BNQ', date: '2026-03-31' });
    expect(
      p.lines.map((l: { accountNumber: string; debit: string; credit: string }) => [
        l.accountNumber,
        l.debit,
        l.credit,
      ]),
    ).toEqual([
      [sup, '250.00', '0.00'],
      ['512001', '0.00', '250.00'],
    ]);
    const codes = await t.db
      .select({ code: entryLine.letteringCode })
      .from(entryLine)
      .innerJoin(account, eq(account.id, entryLine.accountId))
      .where(eq(account.number, sup));
    expect(codes).toHaveLength(2);
    expect(codes[0]!.code).not.toBeNull();
    expect(codes[0]!.code).toBe(codes[1]!.code);
    expect(
      (await t.db.select().from(supplierInvoice).where(eq(supplierInvoice.id, inv.id)))[0],
    ).toMatchObject({ status: 'PAID', paymentEntryId: pay.entryId });
  });

  it('a validated purchase entry blocks a change of amount (409) but not a comment', async () => {
    const { s, inv } = await newInvoice();
    const [row] = await t.db.select().from(supplierInvoice).where(eq(supplierInvoice.id, inv.id));
    await post('/api/v1/entries/validate', { ids: [row!.entryId] });
    const same = {
      supplierId: s.id,
      pieceRef: 'F-1',
      date: '2026-03-10',
      totalExcl: '240',
      totalVat: '15,64',
      paymentMethod: 'TRANSFER',
      receiptIds: [],
    };
    expect(
      (await put(`/api/v1/supplier-invoices/${inv.id}`, { ...same, comment: 'note' })).statusCode,
    ).toBe(200);
    expect(
      (await put(`/api/v1/supplier-invoices/${inv.id}`, { ...same, totalExcl: '300', comment: '' }))
        .statusCode,
    ).toBe(409);
  });
});
