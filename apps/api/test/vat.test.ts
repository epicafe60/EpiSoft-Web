import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  cashSession,
  entryLine,
  fiscalYear,
  posDevice,
  product,
  sale,
  saleLine,
  salePayment,
  supplierInvoice,
  vatRegimeChange,
  type Db,
} from '@episoft/db';
import { FRANCHISE_MENTION, EXEMPT_MENTION, type VatRegime } from '@episoft/shared';
import { generateSessionEntry } from '../src/modules/accounting/auto';
import { closingPdf } from '../src/modules/pos/closing-pdf';
import { sessionVat } from '../src/modules/pos/closing-vat';
import { createUser, login, setupTestApp } from './helpers';

// R-TVA-01..07: the VAT regimes (liable, franchise, exempt) on the ticket, the closing, the entry of
// a sale, the entry of a supplier invoice and the VAT statement.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

async function resetAccounting(db: Db) {
  await db.execute(sql`truncate app.reconciliation, app.bank_line, app.bank_statement, app.bank_rule, app.bank_account,
    app.cash_deposit, app.entry_template_line, app.entry_template, app.entry_line, app.entry, app.fiscal_year,
    app.invoice_receipt, app.supplier_invoice, app.number_counter, app.vat_regime_change cascade`);
  await db.execute(sql`delete from app.supplier`);
  await db.execute(
    sql`delete from app.account where number ~ '^401[0-9]{3}$' and number <> '401000'`,
  );
}

beforeEach(async () => {
  await t.reset();
  await resetAccounting(t.db);
  const u = await createUser(t.db, { roles: ['COMPTA', 'APPROS', 'ADMIN'] });
  h = await login(t.app, u.username!);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/fiscal-years',
    headers: h,
    payload: { label: 'Exercice 2026', startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  expect(res.statusCode).toBe(200);
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });

const REGIMES: VatRegime[] = ['LIABLE', 'FRANCHISE', 'EXEMPT'];
const setRegime = (regime: VatRegime, effectiveFrom = '2026-01-01') =>
  t.db.insert(vatRegimeChange).values({ regime, effectiveFrom });

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

async function linesOfEntry(entryId: string) {
  const rows = await t.db
    .select({ number: account.number, debit: entryLine.debit, credit: entryLine.credit })
    .from(entryLine)
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(eq(entryLine.entryId, entryId))
    .orderBy(entryLine.lineNo);
  const cents = (v: string) => Math.round(Number(v) * 100);
  return rows.map((r) => ({ number: r.number, debit: cents(r.debit), credit: cents(r.credit) }));
}

describe('R-TVA-07: the regime, effective from a date', () => {
  it('is LIABLE by default, changes from a date and keeps its history', async () => {
    expect((await call('GET', '/vat-regime')).json()).toEqual({ current: 'LIABLE', changes: [] });
    const res = await call('POST', '/vat-regime', {
      regime: 'FRANCHISE',
      effectiveFrom: '2026-03-01',
    });
    expect(res.statusCode, res.body).toBe(200);
    const later = await call('POST', '/vat-regime', {
      regime: 'EXEMPT',
      effectiveFrom: '2099-01-01',
    });
    expect(later.statusCode, later.body).toBe(200);
    const info = (await call('GET', '/vat-regime')).json();
    expect(info.current).toBe('FRANCHISE'); // the exempt regime starts in 2099
    expect(info.changes).toEqual([
      { effectiveFrom: '2026-03-01', regime: 'FRANCHISE' },
      { effectiveFrom: '2099-01-01', regime: 'EXEMPT' },
    ]);
  });

  it('refuses a date in a closed year, a duplicate date and a no-op, in French', async () => {
    await t.db
      .insert(fiscalYear)
      .values({ label: '2025', startDate: '2025-01-01', endDate: '2025-12-31', status: 'CLOSED' });
    const closed = await call('POST', '/vat-regime', {
      regime: 'EXEMPT',
      effectiveFrom: '2025-06-01',
    });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().detail ?? closed.body).toMatch(/exercice clos/);
    expect(
      (await call('POST', '/vat-regime', { regime: 'FRANCHISE', effectiveFrom: '2026-05-01' }))
        .statusCode,
    ).toBe(200);
    const dup = await call('POST', '/vat-regime', {
      regime: 'EXEMPT',
      effectiveFrom: '2026-05-01',
    });
    expect(dup.statusCode).toBe(400);
    const noop = await call('POST', '/vat-regime', {
      regime: 'FRANCHISE',
      effectiveFrom: '2026-06-01',
    });
    expect(noop.statusCode).toBe(400);
    expect(noop.json().detail ?? noop.body).toMatch(/déjà celui en vigueur/);
  });

  it('refuses a user without the right role', async () => {
    const caisse = await login(t.app, (await createUser(t.db, { roles: ['CAISSE'] })).username!);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/vat-regime',
      headers: caisse,
      payload: { regime: 'FRANCHISE', effectiveFrom: '2026-05-01' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('supplier invoice entry, by regime (R-TVA-03, R-TVA-04)', () => {
  async function newSupplier() {
    return (await call('POST', '/suppliers', supplierForm)).json() as { id: string };
  }
  const invoiceBody = (supplierId: string, extra: object) => ({
    supplierId,
    pieceRef: `F-${Math.random().toString(36).slice(2, 8)}`,
    date: '2026-03-10',
    paymentMethod: 'TRANSFER',
    comment: '',
    receiptIds: [],
    ...extra,
  });
  async function entryOf(invoiceId: string) {
    const [row] = await t.db
      .select()
      .from(supplierInvoice)
      .where(eq(supplierInvoice.id, invoiceId));
    return { row: row!, lines: await linesOfEntry(row!.entryId!) };
  }

  it('LIABLE: expense HT, deductible VAT per rate on 445660, supplier for the TTC', async () => {
    const s = await newSupplier();
    const res = await call(
      'POST',
      '/supplier-invoices',
      invoiceBody(s.id, {
        vatLines: [
          { rate: '5.50', excl: '100', vat: '5.50' },
          { rate: '20', excl: '50', vat: '10' },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const { row, lines } = await entryOf(res.json().id);
    expect(row).toMatchObject({
      vatRegime: 'LIABLE',
      totalExcl: '150.00',
      totalVat: '15.50',
      totalIncl: '165.50',
    });
    expect(lines.map((l) => [l.number, l.debit, l.credit])).toEqual([
      ['607000', 15000, 0],
      ['445660', 550, 0],
      ['445660', 1000, 0],
      [expect.stringMatching(/^401/), 0, 16550],
    ]);
    const detail = (await call('GET', `/supplier-invoices/${row.id}`)).json();
    expect(detail.vatLines).toEqual([
      { rate: '5.50', excl: '100.00', vat: '5.50' },
      { rate: '20.00', excl: '50.00', vat: '10.00' },
    ]);
  });

  it('LIABLE refuses an invoice without breakdown, a wrong VAT, a duplicate rate (400, French)', async () => {
    const s = await newSupplier();
    const no = await call('POST', '/supplier-invoices', invoiceBody(s.id, { totalIncl: '120' }));
    expect(no.statusCode).toBe(400);
    expect(no.body).toMatch(/assujettie à la TVA/);
    const bad = await call(
      'POST',
      '/supplier-invoices',
      invoiceBody(s.id, { vatLines: [{ rate: '20', excl: '100', vat: '25' }] }),
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatch(/Ligne 1/);
    const twice = await call(
      'POST',
      '/supplier-invoices',
      invoiceBody(s.id, {
        vatLines: [
          { rate: '20', excl: '100', vat: '20' },
          { rate: '20.00', excl: '10', vat: '2' },
        ],
      }),
    );
    expect(twice.statusCode).toBe(400);
    expect(twice.body).toMatch(/deux fois/);
  });

  it.each(['FRANCHISE', 'EXEMPT'] as const)(
    '%s: no deductible VAT, the expense is the TTC; the breakdown is optional',
    async (regime) => {
      await setRegime(regime);
      const s = await newSupplier();
      const res = await call(
        'POST',
        '/supplier-invoices',
        invoiceBody(s.id, { totalIncl: '120,50' }),
      );
      expect(res.statusCode, res.body).toBe(200);
      const { row, lines } = await entryOf(res.json().id);
      expect(row).toMatchObject({ vatRegime: regime, totalExcl: '120.50', totalVat: '0.00' });
      expect(lines.map((l) => [l.number, l.debit, l.credit])).toEqual([
        ['607000', 12050, 0],
        [expect.stringMatching(/^401/), 0, 12050],
      ]);
      // With a breakdown typed anyway: kept for information, still no deductible VAT.
      const withLines = await call(
        'POST',
        '/supplier-invoices',
        invoiceBody(s.id, { vatLines: [{ rate: '20', excl: '100', vat: '20' }] }),
      );
      expect(withLines.statusCode, withLines.body).toBe(200);
      const second = await entryOf(withLines.json().id);
      expect(second.lines.map((l) => l.number)).not.toContain('445660');
      expect(second.lines[0]).toMatchObject({ number: '607000', debit: 12000 });
      // Neither a breakdown nor a total: refused.
      const none = await call('POST', '/supplier-invoices', invoiceBody(s.id, {}));
      expect(none.statusCode).toBe(400);
    },
  );

  it('an invoice keeps the regime of its date: a later change never recomputes it', async () => {
    const s = await newSupplier();
    const created = await call(
      'POST',
      '/supplier-invoices',
      invoiceBody(s.id, { vatLines: [{ rate: '20', excl: '100', vat: '20' }] }),
    );
    expect(created.statusCode).toBe(200);
    await call('POST', '/vat-regime', { regime: 'FRANCHISE', effectiveFrom: '2026-06-01' });
    // An invoice dated before the change is still liable; one dated after is not.
    const before = await call(
      'POST',
      '/supplier-invoices',
      invoiceBody(s.id, { vatLines: [{ rate: '20', excl: '10', vat: '2' }], date: '2026-05-31' }),
    );
    expect(before.statusCode, before.body).toBe(200);
    const after = await call(
      'POST',
      '/supplier-invoices',
      invoiceBody(s.id, { totalIncl: '12', date: '2026-06-01' }),
    );
    expect(after.statusCode, after.body).toBe(200);
    const regimes = await t.db
      .select({ r: supplierInvoice.vatRegime })
      .from(supplierInvoice)
      .orderBy(supplierInvoice.date);
    expect(regimes.map((x) => x.r)).toEqual(['LIABLE', 'LIABLE', 'FRANCHISE']);
  });
});

describe('sales, closing and statement, by regime (R-TVA-01, R-TVA-04, R-TVA-05, R-TVA-06)', () => {
  let n = 0;
  /** A closed session with 12 € at 20 % + 10.55 € at 5.5 % + 3 € at 0 % + a 5 € donation. */
  async function session(regime: VatRegime, day = '2026-07-06') {
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
    const mk = async (code: string, rate: string, euros: string) => {
      const [p] = await t.db
        .insert(product)
        .values({ code: `${code}${n}`, name: `P ${code}${n}`, salePrice: euros, vatRate: rate })
        .returning();
      return p!;
    };
    const p20 = await mk('A', '20.00', '12.00');
    const p55 = await mk('B', '5.50', '10.55');
    const p0 = await mk('C', '0.00', '3.00');
    const [don] = await t.db
      .insert(product)
      .values({ code: '01004', name: 'Don', salePrice: '5', vatRate: '0.00' })
      .onConflictDoNothing()
      .returning();
    const donation =
      don ?? (await t.db.select().from(product).where(eq(product.code, '01004')))[0]!;
    const id = crypto.randomUUID();
    await t.db.insert(sale).values({
      id,
      number: `T-2026-${String(n).padStart(6, '0')}`,
      sessionId: sid,
      soldAt: new Date(`${day}T09:00:00Z`),
      vatRegime: regime,
      total: '30.55',
    });
    const rows: [typeof p20, string, string][] = [
      [p20, '20.00', '12.00'],
      [p55, '5.50', '10.55'],
      [p0, '0.00', '3.00'],
      [donation, '0.00', '5.00'],
    ];
    await t.db.insert(saleLine).values(
      rows.map(([p, rate, euros], i) => ({
        saleId: id,
        lineNo: i + 1,
        productId: p.id,
        label: p.name,
        qty: '1',
        unitPrice: euros,
        lineTotal: euros,
        vatRate: rate,
      })),
    );
    await t.db.insert(salePayment).values({ saleId: id, method: 'CASH', amount: '30.55' });
    return sid;
  }

  it('LIABLE: the session entry credits HT per account and the VAT collected per rate', async () => {
    const sid = await session('LIABLE');
    const entryId = await t.db.transaction((tx) => generateSessionEntry(tx, sid, null));
    const lines = await linesOfEntry(entryId!);
    const by = (num: string) => lines.filter((l) => l.number === num);
    expect(by('445712')).toEqual([{ number: '445712', debit: 0, credit: 200 }]); // 12.00 / 1.2
    expect(by('445713')).toEqual([{ number: '445713', debit: 0, credit: 55 }]); // 10.55 / 1.055
    // 707: 10.00 + 10.00 + 3.00 (0 %); the donation goes to 754 without VAT.
    expect(by('707000')).toEqual([{ number: '707000', debit: 0, credit: 2300 }]);
    expect(by('754000')).toEqual([{ number: '754000', debit: 0, credit: 500 }]);
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(3055);
  });

  it.each(['FRANCHISE', 'EXEMPT'] as const)(
    '%s: the session entry is TTC on 707, no 4457 account',
    async (regime) => {
      const sid = await session(regime);
      const entryId = await t.db.transaction((tx) => generateSessionEntry(tx, sid, null));
      const lines = await linesOfEntry(entryId!);
      expect(lines.some((l) => l.number.startsWith('4457'))).toBe(false);
      expect(lines.find((l) => l.number === '707000')).toMatchObject({ credit: 2555 });
      expect(lines.find((l) => l.number === '754000')).toMatchObject({ credit: 500 });
      expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(lines.reduce((s, l) => s + l.credit, 0));
    },
  );

  it('the weekly proposal splits the VAT too, and mixes regimes ticket by ticket', async () => {
    await session('LIABLE', '2026-07-06');
    await session('FRANCHISE', '2026-07-07');
    const res = await call(
      'GET',
      '/accounting/proposals?from=2026-07-01&to=2026-07-31&grouping=WEEK',
    );
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.json().proposals[0].lines as { account: string; credit: string }[];
    const vat = lines.filter((l) => l.account.startsWith('4457'));
    expect(vat.map((l) => [l.account, l.credit])).toEqual([
      ['445712', '2.00'],
      ['445713', '0.55'],
    ]); // only the liable ticket
    expect(lines.find((l) => l.account === '707000')!.credit).toBe('48.55'); // 23.00 + 25.55 (TTC)
  });

  it('closing: VAT by rate for liable tickets, the mention for the others, donations apart', async () => {
    const liable = await sessionVat(t.db, await session('LIABLE'));
    expect(liable.untaxed).toEqual([]);
    expect(liable.breakdown.byRate).toEqual([
      { rate: '0.00', exclCents: 300, vatCents: 0, inclCents: 300 },
      { rate: '5.50', exclCents: 1000, vatCents: 55, inclCents: 1055 },
      { rate: '20.00', exclCents: 1000, vatCents: 200, inclCents: 1200 },
    ]);
    expect(liable.breakdown.outOfScopeCents).toBe(500);

    const fr = await sessionVat(t.db, await session('FRANCHISE'));
    expect(fr.breakdown.byRate).toEqual([]);
    expect(fr.untaxed).toEqual([
      { regime: 'FRANCHISE', inclCents: 2555, mention: FRANCHISE_MENTION },
    ]);

    const ex = await sessionVat(t.db, await session('EXEMPT'));
    expect(ex.breakdown.byRate).toEqual([]);
    expect(ex.untaxed).toEqual([{ regime: 'EXEMPT', inclCents: 2555, mention: EXEMPT_MENTION }]);
  });

  it('the closing report PDF is produced under each regime', async () => {
    for (const regime of REGIMES) {
      const pdf = await closingPdf(t.db, await session(regime));
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }
  });

  it('the statement counts only the liable operations, by rate, with the deductible VAT', async () => {
    await session('LIABLE', '2026-07-06');
    await session('FRANCHISE', '2026-07-07'); // not in the statement
    const s = (await call('POST', '/suppliers', supplierForm)).json() as { id: string };
    await call('POST', '/supplier-invoices', {
      supplierId: s.id,
      pieceRef: 'F-STAT',
      date: '2026-07-10',
      paymentMethod: null,
      comment: '',
      receiptIds: [],
      vatLines: [{ rate: '20', excl: '50', vat: '10' }],
    });
    const res = await call('GET', '/reports/vat?from=2026-07-01&to=2026-07-31');
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().rows as { cells: Record<string, string | null> }[];
    const byRate = (label: string) => rows.find((r) => r.cells.rate === label)!.cells;
    expect(byRate('20 %')).toMatchObject({
      salesBase: '10.00',
      collected: '2.00',
      purchasesBase: '50.00',
      deductible: '10.00',
      balance: '-8.00',
    });
    expect(byRate('5,5 %')).toMatchObject({ salesBase: '10.00', collected: '0.55' });
    expect(byRate('Total')).toMatchObject({
      collected: '2.55',
      deductible: '10.00',
      balance: '-7.45',
    });
    expect(byRate('Crédit de TVA')).toMatchObject({ balance: '7.45' });
    // The Excel export works.
    const xlsx = await call('GET', '/reports/vat?from=2026-07-01&to=2026-07-31&format=xlsx');
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });
});
