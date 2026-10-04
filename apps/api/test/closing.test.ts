import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectIntegrity } from './integrity-helper';
import { account, entry, type Db } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
afterEach(() => expectIntegrity(t.db));

async function resetAccounting(db: Db) {
  await db.execute(sql`truncate app.reconciliation, app.bank_line, app.bank_statement, app.bank_rule, app.bank_account,
    app.cash_deposit, app.entry_template_line, app.entry_template, app.entry_line, app.entry, app.fiscal_year,
    app.invoice_receipt, app.supplier_invoice, app.number_counter cascade`);
}

beforeEach(async () => {
  await t.reset();
  await resetAccounting(t.db);
  const u = await createUser(t.db, { roles: ['COMPTA', 'ADMIN'] });
  h = await login(t.app, u.username!);
});

const post = (url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, headers: h, payload: payload as object });
const get = (url: string) => t.app.inject({ url, headers: h });

const acct = async (number: string) =>
  (await t.db.select().from(account).where(eq(account.number, number)))[0]!;
const journalId = async (code: string) =>
  (await get('/api/v1/journals')).json().find((j: { code: string }) => j.code === code)
    .id as string;

async function book(date: string, debit: string, credit: string, amount: string, validate = true) {
  const res = await post('/api/v1/entries', {
    journalId: await journalId('OD'),
    date,
    pieceRef: null,
    label: `Écriture ${debit}/${credit}`,
    mode: null,
    lines: [
      { accountId: (await acct(debit)).id, label: '', debit: amount, credit: '' },
      { accountId: (await acct(credit)).id, label: '', debit: '', credit: amount },
    ],
  });
  expect(res.statusCode).toBe(200);
  if (validate) {
    const v = await post('/api/v1/entries/validate', { ids: [res.json().id] });
    expect(v.statusCode).toBe(200);
  }
  return res.json().id as string;
}

async function setupYear() {
  const res = await post('/api/v1/fiscal-years', {
    label: 'Exercice 2026',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  expect(res.statusCode).toBe(200);
  const years = (await get('/api/v1/fiscal-years')).json();
  return years[0].id as string;
}

describe('reports (R-CPT-16, R-CPT-17)', () => {
  it('computes the income statement, the situation and the trial balance', async () => {
    const fy = await setupYear();
    await book('2026-02-10', '512001', '707000', '1000');
    await book('2026-03-10', '607000', '512001', '400');
    const income = (await get(`/api/v1/reports/income?fiscalYearId=${fy}`)).json();
    const last = income.rows[income.rows.length - 1];
    expect(last.cells).toMatchObject({ label: 'Résultat : excédent', amount: '600.00' });
    const sit = (await get(`/api/v1/reports/situation?fiscalYearId=${fy}`)).json();
    expect(
      sit.rows.find((r: { cells: { label: string } }) => r.cells.label === 'Marge brute').cells
        .amount,
    ).toBe('600.00');
    const bal = (await get(`/api/v1/reports/balance?fiscalYearId=${fy}`)).json();
    const totals = bal.rows[bal.rows.length - 1].cells;
    expect(totals.debit).toBe(totals.credit);
    const xlsx = await get(`/api/v1/reports/balance?fiscalYearId=${fy}&format=xlsx`);
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const pdf = await get(`/api/v1/reports/journal?fiscalYearId=${fy}&format=pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('refuses the FEC while drafts remain, then exports validated entries (R-CPT-19)', async () => {
    const fy = await setupYear();
    await book('2026-02-10', '512001', '707000', '1000', false);
    expect((await get(`/api/v1/reports/fec/${fy}`)).statusCode).toBe(400);
    await post('/api/v1/entries/validate', { from: '2026-01-01', to: '2026-12-31' });
    const fec = await get(`/api/v1/reports/fec/${fy}`);
    expect(fec.statusCode).toBe(200);
    const lines = fec.body.trimEnd().split('\r\n');
    expect(lines[0]).toContain('JournalCode\tJournalLib\tEcritureNum');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('OD-2026-0001');
  });
});

describe('year-end closing (R-CPT-18)', () => {
  it('blocks on drafts, then closes with the result entry and one carry-forward', async () => {
    const fy = await setupYear();
    await book('2026-02-10', '512001', '707000', '1000');
    const draft = await book('2026-03-10', '607000', '512001', '400', false);

    const check = (await get(`/api/v1/fiscal-years/${fy}/closing-check`)).json();
    expect(check.canClose).toBe(false);
    expect((await post(`/api/v1/fiscal-years/${fy}/close`, { confirm: true })).statusCode).toBe(
      409,
    );

    await post('/api/v1/entries/validate', { ids: [draft] });
    expect((await get(`/api/v1/fiscal-years/${fy}/closing-check`)).json().canClose).toBe(true);
    const done = await post(`/api/v1/fiscal-years/${fy}/close`, { confirm: true });
    expect(done.statusCode).toBe(200);
    expect(done.json().ranEntryId).toBeTruthy();

    // 6/7 are zeroed against 120000; the income statement still shows the year's result.
    const income = (await get(`/api/v1/reports/income?fiscalYearId=${fy}`)).json();
    expect(income.rows[income.rows.length - 1].cells.amount).toBe('600.00');
    const sheet = (await get(`/api/v1/reports/balance-sheet?fiscalYearId=${fy}`)).json();
    const total = (label: string) =>
      sheet.rows.find((r: { cells: { label: string } }) => r.cells.label === label).cells.amount;
    expect(total('Total de l’actif')).toBe(total('Total du passif'));

    // the carry-forward sits in the next year, on its first day
    const [ran] = await t.db.select().from(entry).where(eq(entry.sourceType, 'closing_ran'));
    expect(ran!.date).toBe('2027-01-01');
    expect(ran!.status).toBe('VALIDATED');

    // the year is locked and cannot be closed twice
    expect((await post(`/api/v1/fiscal-years/${fy}/close`, { confirm: true })).statusCode).toBe(
      409,
    );
    const late = await post('/api/v1/entries', {
      journalId: await journalId('OD'),
      date: '2026-06-01',
      pieceRef: null,
      label: 'Trop tard',
      mode: null,
      lines: [
        { accountId: (await acct('607000')).id, label: '', debit: '1', credit: '' },
        { accountId: (await acct('512001')).id, label: '', debit: '', credit: '1' },
      ],
    });
    expect(late.statusCode).toBe(409);
  });

  it('reopens the year (ADMIN) by removing only the closing entries', async () => {
    const fy = await setupYear();
    await book('2026-02-10', '512001', '707000', '1000');
    await post(`/api/v1/fiscal-years/${fy}/close`, { confirm: true });
    const before = await t.db.select().from(entry);
    expect(before.length).toBe(3); // sale, result, carry-forward
    const res = await post(`/api/v1/fiscal-years/${fy}/reopen`);
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe(2);
    expect(await t.db.select().from(entry)).toHaveLength(1);
    // and it can be closed again
    expect((await post(`/api/v1/fiscal-years/${fy}/close`, { confirm: true })).statusCode).toBe(
      200,
    );

    const plain = await createUser(t.db, { roles: ['COMPTA'] });
    h = await login(t.app, plain.username!);
    expect((await post(`/api/v1/fiscal-years/${fy}/reopen`)).statusCode).toBe(403);
  });
});
