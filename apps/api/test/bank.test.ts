import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, bankLine, entry, household, type Db } from '@episoft/db';
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
  const u = await createUser(t.db, { roles: ['COMPTA', 'APPROS', 'ADHERENTS'] });
  h = await login(t.app, u.username!);
  await t.app.inject({
    method: 'POST',
    url: '/api/v1/fiscal-years',
    headers: h,
    payload: { label: 'Exercice 2026', startDate: '2026-01-01', endDate: '2026-12-31' },
  });
});

const post = (url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, headers: h, payload: payload as object });
const get = (url: string) => t.app.inject({ url, headers: h });

const acct = async (number: string) =>
  (await t.db.select().from(account).where(eq(account.number, number)))[0]!;

async function bankAccountId() {
  const res = await post('/api/v1/bank/accounts', {
    label: 'Compte courant',
    iban: null,
    accountId: (await acct('512001')).id,
    active: true,
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<DTSTART>20260301<DTEND>20260331
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260305<TRNAMT>50.00<FITID>A1<NAME>VIR DUPONT<MEMO>cagnotte</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260310<TRNAMT>-12.30<FITID>A2<NAME>FRAIS BANCAIRES</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1037.70<DTASOF>20260331</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const importFile = (bankAccountId: string, body: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/bank/statements/import?bankAccountId=${bankAccountId}`,
    headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': 'mars.ofx' },
    payload: Buffer.from(body, 'utf8'),
  });

describe('bank import (R-CPT-12)', () => {
  it('imports an OFX file once: a second import adds nothing', async () => {
    const id = await bankAccountId();
    const first = await importFile(id, OFX);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ inserted: 2, duplicates: 0 });
    const second = await importFile(id, OFX);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ statementId: null, inserted: 0 });
    expect(await t.db.select().from(bankLine)).toHaveLength(2);
    const detail = (await get(`/api/v1/bank/statements/${first.json().statementId}`)).json();
    // opening = closing − Σ lines
    expect(detail.openingBalance).toBe('1000.00');
    expect(detail.closingBalance).toBe('1037.70');
    expect(detail.gap).toBe('0.00');
  });

  it('matches lines with an account, tops up a household, and closes the statement', async () => {
    const id = await bankAccountId();
    const imp = await importFile(id, OFX);
    const statementId = imp.json().statementId as string;
    const [hh] = await t.db.insert(household).values({ transferReference: 'DUPONT01' }).returning();
    await t.db.execute(sql`update app.bank_line set label = 'VIR DUPONT01' where fitid = 'A1'`);

    // cannot close with unmatched lines
    expect((await post(`/api/v1/bank/statements/${statementId}/close`)).statusCode).toBe(409);

    const detail = (await get(`/api/v1/bank/statements/${statementId}`)).json();
    const credit = detail.lines.find((l: { amount: string }) => l.amount === '50.00');
    const debit = detail.lines.find((l: { amount: string }) => l.amount === '-12.30');
    expect(credit.suggestions[0]).toMatchObject({ kind: 'HOUSEHOLD', householdId: hh!.id });

    const res = await post('/api/v1/bank/lines/match', {
      items: [
        { lineId: credit.id, action: 'HOUSEHOLD', householdId: hh!.id },
        { lineId: debit.id, action: 'ACCOUNT', accountId: (await acct('658000')).id },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBe(2);
    // matching twice is refused
    expect(
      (
        await post('/api/v1/bank/lines/match', {
          items: [{ lineId: debit.id, action: 'ACCOUNT', accountId: (await acct('658000')).id }],
        })
      ).statusCode,
    ).toBe(409);

    const entries = await t.db.select().from(entry);
    expect(entries).toHaveLength(2);
    const wallet = await t.db.execute(
      sql`select balance from app.household_balance where household_id = ${hh!.id}`,
    );
    expect((wallet.rows[0] as { balance: string }).balance).toBe('50.00');

    const closed = await post(`/api/v1/bank/statements/${statementId}/close`);
    expect(closed.statusCode).toBe(200);
    // a closed statement refuses further changes
    expect((await post(`/api/v1/bank/lines/${debit.id}/unmatch`)).statusCode).toBe(409);
  });

  it('refuses to close when the statement does not add up', async () => {
    const id = await bankAccountId();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/bank/statements/import?bankAccountId=${id}&openingBalance=100&closingBalance=500`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': 'x.csv' },
      payload: Buffer.from('Date;Libellé;Montant\n05/03/2026;PAIEMENT;-10,00\n', 'utf8'),
    });
    expect(res.statusCode).toBe(200);
    const detail = (await get(`/api/v1/bank/statements/${res.json().statementId}`)).json();
    expect(detail.gap).toBe('410.00');
    await post('/api/v1/bank/lines/match', {
      items: [
        { lineId: detail.lines[0].id, action: 'ACCOUNT', accountId: (await acct('658000')).id },
      ],
    });
    expect((await post(`/api/v1/bank/statements/${res.json().statementId}/close`)).statusCode).toBe(
      409,
    );
  });
});

describe('bank rules (R-CPT-13)', () => {
  it('rejects an invalid regex and tests a rule on the history', async () => {
    const id = await bankAccountId();
    await importFile(id, OFX);
    const rule = {
      priority: 10,
      label: 'Frais',
      pattern: 'FRAIS',
      matchType: 'CONTAINS',
      direction: 'OUT',
      minAmount: null,
      maxAmount: null,
      counterAccountId: (await acct('658000')).id,
      journalId: null,
      mode: null,
      labelTemplate: null,
      householdMatch: false,
      supplierId: null,
      active: true,
    };
    expect(
      (await post('/api/v1/bank/rules', { ...rule, matchType: 'REGEX', pattern: '(' })).statusCode,
    ).toBe(400);
    const test = await post('/api/v1/bank/rules/test', rule);
    expect(test.json().count).toBe(1);
    expect((await post('/api/v1/bank/rules', rule)).statusCode).toBe(200);
  });
});
