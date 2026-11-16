import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectIntegrity } from './integrity-helper';
import { entry, entryLine, priceHistory, product, supplierInvoice, type Db } from '@episoft/db';
import { toShopDate } from '../src/lib/dates';
import { recordMovement } from '../src/modules/stock/ledger';
import { createUser, login, setupTestApp } from './helpers';

// Lot D: supplier credit notes, cancelling an invoice, reversing a payment, cash cap,
// weighted average cost (CMUP) of the stock.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
afterEach(() => expectIntegrity(t.db));

async function resetAll(db: Db) {
  await db.execute(sql`truncate app.supplier_credit_allocation, app.supplier_credit_note, app.reconciliation, app.bank_line,
    app.bank_statement, app.bank_rule, app.bank_account, app.cash_deposit, app.entry_template_line, app.entry_template,
    app.entry_line, app.entry, app.fiscal_year, app.invoice_receipt, app.supplier_invoice, app.goods_receipt_line,
    app.goods_receipt, app.purchase_order_line, app.purchase_order, app.inventory_line, app.inventory_session,
    app.stock_movement, app.price_history, app.number_counter, app.product_barcode cascade`);
  await db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
  await db.execute(sql`delete from app.supplier`);
}

beforeEach(async () => {
  await t.reset();
  await resetAll(t.db);
  const u = await createUser(t.db, { roles: ['APPROS', 'PRODUITS', 'COMPTA', 'ADMIN'] });
  h = await login(t.app, u.username!);
});

const post = (url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, headers: h, payload: payload as object });
const get = (url: string) => t.app.inject({ url, headers: h });

const supplierForm = {
  region: '07',
  name: 'Ferme du Vexin',
  contact: '',
  street: '',
  postcode: '',
  communeId: null,
  phone: '',
  email: 'ferme@example.org',
  website: '',
  priceListUrl: '',
  active: true,
  publicNotes: '',
  privateNotes: '',
  referentMemberId: null,
  sendsPo: true,
  accountNumber: '',
  minOrderAmount: null,
  paymentTermsDays: 30,
  deliveryDay: 'mardi',
};

const today = () => toShopDate(new Date());

async function newSupplier() {
  return (await post('/api/v1/suppliers', supplierForm)).json() as { id: string };
}

async function newInvoice(supplierId: string, pieceRef: string, incl: string) {
  const res = await post('/api/v1/supplier-invoices', {
    supplierId,
    pieceRef,
    date: today(),
    totalExcl: incl,
    totalVat: '0',
    totalIncl: incl,
    paymentMethod: 'TRANSFER',
    comment: '',
    receiptIds: [],
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

async function validateAll() {
  const res = await post('/api/v1/entries/validate', { from: '2020-01-01', to: '2099-12-31' });
  expect(res.statusCode).toBe(200);
}

/** Balance (debit - credit) in cents of the accounts starting with a prefix, validated entries. */
async function balance(prefix: string): Promise<number> {
  const r = await t.db.execute<{ b: string }>(sql`
    select coalesce(sum(l.debit - l.credit), 0)::text as b
      from app.entry_line l join app.entry e on e.id = l.entry_id join app.account a on a.id = l.account_id
     where a.number like ${prefix + '%'}`);
  return Math.round(Number(r.rows[0]!.b) * 100);
}

const creditForm = (
  supplierId: string,
  invoiceId: string | null,
  pieceRef: string,
  incl: string,
) => ({
  supplierId,
  invoiceId,
  pieceRef,
  date: today(),
  totalExcl: incl,
  totalVat: '0',
  totalIncl: incl,
  comment: '',
});

describe('supplier credit notes', () => {
  it('refuses a credit note larger than its invoice, then offsets it against the invoice to pay', async () => {
    const s = await newSupplier();
    const inv = await newInvoice(s.id, 'F-100', '100');

    const tooBig = await post(
      '/api/v1/supplier-credit-notes',
      creditForm(s.id, inv, 'AV-1', '120'),
    );
    expect(tooBig.statusCode).toBe(409);
    expect(tooBig.json().detail).toContain('dépasse');

    const ok = await post('/api/v1/supplier-credit-notes', creditForm(s.id, inv, 'AV-1', '30'));
    expect(ok.statusCode).toBe(200);
    // What is left of the invoice (70) bounds the next credit notes against it.
    const second = await post('/api/v1/supplier-credit-notes', creditForm(s.id, inv, 'AV-2', '80'));
    expect(second.statusCode).toBe(409);

    // The entry of the credit note is the reverse of an invoice: 401 debited, expense credited.
    const lines = await t.db
      .select()
      .from(entryLine)
      .where(eq(entryLine.entryId, ok.json().entryId));
    expect(lines.map((l) => [l.debit, l.credit]).sort()).toEqual([
      ['0.00', '30.00'],
      ['30.00', '0.00'],
    ]);

    const noteId = ok.json().id as string;
    const apply = await post(`/api/v1/supplier-credit-notes/${noteId}/apply`, {
      invoiceId: inv,
      amount: '30',
      date: today(),
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().netToPay).toBe('70.00');
    expect(
      (
        await post(`/api/v1/supplier-credit-notes/${noteId}/apply`, {
          invoiceId: inv,
          amount: '1',
          date: today(),
        })
      ).statusCode,
    ).toBe(409); // nothing left on the credit note

    const detail = (await get(`/api/v1/supplier-invoices/${inv}`)).json();
    expect(detail).toMatchObject({ creditApplied: '30.00', netToPay: '70.00' });

    // An applied credit note cannot be cancelled before its imputation is removed.
    expect(
      (await post(`/api/v1/supplier-credit-notes/${noteId}/cancel`, { reason: 'erreur de saisie' }))
        .statusCode,
    ).toBe(409);

    // The payment is the net amount; the 401 account of the supplier is settled.
    const pay = await post(`/api/v1/supplier-invoices/${inv}/pay`, {
      date: today(),
      method: 'TRANSFER',
    });
    expect(pay.statusCode).toBe(200);
    const paid = await t.db.select().from(entry).where(eq(entry.id, pay.json().entryId));
    expect(paid).toHaveLength(1);
    const payLines = await t.db.select().from(entryLine).where(eq(entryLine.entryId, paid[0]!.id));
    expect(payLines.reduce((n, l) => n + Number(l.debit), 0)).toBe(70);
    await validateAll();
    expect(await balance('401')).toBe(0);
    expect(await balance('512')).toBe(-7000);
  });

  it('settles an invoice fully covered by credit notes without any payment', async () => {
    const s = await newSupplier();
    const inv = await newInvoice(s.id, 'F-200', '50');
    const note = (
      await post('/api/v1/supplier-credit-notes', creditForm(s.id, inv, 'AV-9', '50'))
    ).json();
    await post(`/api/v1/supplier-credit-notes/${note.id}/apply`, {
      invoiceId: inv,
      amount: '50',
      date: today(),
    });
    const pay = await post(`/api/v1/supplier-invoices/${inv}/pay`, {
      date: today(),
      method: 'TRANSFER',
    });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().entryId).toBeNull();
    const [row] = await t.db.select().from(supplierInvoice).where(eq(supplierInvoice.id, inv));
    expect(row!.status).toBe('PAID');
    await validateAll();
    expect(await balance('401')).toBe(0);
    // Both 401 lines of the group are lettered together.
    const lettered = await t.db.execute<{ n: number }>(
      sql`select count(distinct lettering_code)::int as n from app.entry_line where lettering_code is not null`,
    );
    expect(lettered.rows[0]!.n).toBe(1);
  });

  it('keeps a standalone credit note, lists it and exports it', async () => {
    const s = await newSupplier();
    const note = await post(
      '/api/v1/supplier-credit-notes',
      creditForm(s.id, null, 'AV-RFA', '12,50'),
    );
    expect(note.statusCode).toBe(200);
    expect(
      (await post('/api/v1/supplier-credit-notes', creditForm(s.id, null, 'AV-RFA', '5')))
        .statusCode,
    ).toBe(409);
    const list = (await get('/api/v1/supplier-credit-notes')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pieceRef: 'AV-RFA', totalIncl: '12.50', allocated: '0.00' });
    const xlsx = await get('/api/v1/supplier-credit-notes.xlsx');
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    // Cancelled with a motif: counter entry, never deleted; the piece number is free again.
    expect(
      (await post(`/api/v1/supplier-credit-notes/${note.json().id}/cancel`, { reason: 'x' }))
        .statusCode,
    ).toBe(400);
    const cancel = await post(`/api/v1/supplier-credit-notes/${note.json().id}/cancel`, {
      reason: 'avoir saisi deux fois',
    });
    expect(cancel.statusCode).toBe(200);
    expect(
      (await post('/api/v1/supplier-credit-notes', creditForm(s.id, null, 'AV-RFA', '12,50')))
        .statusCode,
    ).toBe(200);
  });
});

describe('correcting an invoice', () => {
  it('cancels a paid invoice with counter entries, keeps it, and allows entering it again', async () => {
    const s = await newSupplier();
    const inv = await newInvoice(s.id, 'F-300', '80');
    await post(`/api/v1/supplier-invoices/${inv}/pay`, { date: today(), method: 'TRANSFER' });
    await validateAll();
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/supplier-invoices/${inv}`,
      headers: h,
      payload: {
        supplierId: s.id,
        pieceRef: 'F-300',
        date: today(),
        totalExcl: '90',
        totalVat: '0',
        totalIncl: '90',
        paymentMethod: 'TRANSFER',
        comment: '',
        receiptIds: [],
      },
    });
    expect(put.statusCode).toBe(409); // a paid invoice is immutable

    expect(
      (await post(`/api/v1/supplier-invoices/${inv}/cancel`, { reason: 'ab' })).statusCode,
    ).toBe(400);
    const cancel = await post(`/api/v1/supplier-invoices/${inv}/cancel`, {
      reason: 'montant saisi pour le mauvais fournisseur',
    });
    expect(cancel.statusCode).toBe(200);
    const [row] = await t.db.select().from(supplierInvoice).where(eq(supplierInvoice.id, inv));
    expect(row).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'montant saisi pour le mauvais fournisseur',
    });
    // Nothing was deleted: the entries and their counter entries stay, and the books net to zero.
    const entries = await t.db.select().from(entry);
    expect(entries).toHaveLength(4);
    expect(entries.filter((e) => e.reversesEntryId)).toHaveLength(2);
    expect(entries.every((e) => e.status === 'VALIDATED')).toBe(true);
    expect(await balance('401')).toBe(0);
    expect(await balance('512')).toBe(0);
    expect(await balance('607')).toBe(0);
    expect(
      (await post(`/api/v1/supplier-invoices/${inv}/cancel`, { reason: 'encore' })).statusCode,
    ).toBe(409);
    expect(
      (await post(`/api/v1/supplier-invoices/${inv}/pay`, { date: today(), method: 'TRANSFER' }))
        .statusCode,
    ).toBe(409);

    // The same piece number can be entered again.
    await newInvoice(s.id, 'F-300', '80');
  });

  it('reverses a payment and lets it be paid again; an unpaid invoice stays editable', async () => {
    const s = await newSupplier();
    const inv = await newInvoice(s.id, 'F-400', '40');
    expect(
      (await post(`/api/v1/supplier-invoices/${inv}/reverse-payment`, { reason: 'jamais réglée' }))
        .statusCode,
    ).toBe(409);
    await post(`/api/v1/supplier-invoices/${inv}/pay`, { date: today(), method: 'CHEQUE' });
    await validateAll();
    const rev = await post(`/api/v1/supplier-invoices/${inv}/reverse-payment`, {
      reason: 'chèque non remis',
    });
    expect(rev.statusCode).toBe(200);
    const [row] = await t.db.select().from(supplierInvoice).where(eq(supplierInvoice.id, inv));
    expect(row).toMatchObject({ status: 'TO_PAY', paidAt: null });
    expect(await balance('401')).toBe(-4000); // the debt is open again
    const again = await post(`/api/v1/supplier-invoices/${inv}/pay`, {
      date: today(),
      method: 'TRANSFER',
    });
    expect(again.statusCode).toBe(200);
    await validateAll();
    expect(await balance('401')).toBe(0);
  });

  it('cancels an unpaid invoice whose entry is still a draft (the draft goes, nothing is numbered)', async () => {
    const s = await newSupplier();
    const inv = await newInvoice(s.id, 'F-500', '10');
    expect(
      (await post(`/api/v1/supplier-invoices/${inv}/cancel`, { reason: 'doublon de saisie' }))
        .statusCode,
    ).toBe(200);
    expect(await t.db.select().from(entry)).toHaveLength(0);
  });

  it('refuses to cancel an invoice that credit notes refer to', async () => {
    const s = await newSupplier();
    const inv = await newInvoice(s.id, 'F-600', '100');
    await post('/api/v1/supplier-credit-notes', creditForm(s.id, inv, 'AV-600', '10'));
    const res = await post(`/api/v1/supplier-invoices/${inv}/cancel`, {
      reason: 'erreur de fournisseur',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('avoirs');
  });
});

describe('payments in cash (art. D112-3 CMF)', () => {
  it('refuses a supplier payment in cash above 1 000 €, accepts the cap', async () => {
    const s = await newSupplier();
    const big = await newInvoice(s.id, 'F-700', '1000.01');
    const refused = await post(`/api/v1/supplier-invoices/${big}/pay`, {
      date: today(),
      method: 'CASH',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().detail).toContain('1000 €');
    expect(
      (await post(`/api/v1/supplier-invoices/${big}/pay`, { date: today(), method: 'TRANSFER' }))
        .statusCode,
    ).toBe(200);
    const cap = await newInvoice(s.id, 'F-701', '1000');
    expect(
      (await post(`/api/v1/supplier-invoices/${cap}/pay`, { date: today(), method: 'CASH' }))
        .statusCode,
    ).toBe(200);
  });
});

describe('stock valuation at the weighted average cost (R-STK-06)', () => {
  async function newProduct(code: string) {
    const [p] = await t.db
      .insert(product)
      .values({
        code,
        name: `Produit ${code}`,
        salePrice: '9.00',
        purchasePriceExcl: '1.0000',
        vatRate: '0',
        stockQty: '0',
      })
      .returning();
    return p!;
  }
  const valuation = async (basis = 'excl') =>
    (await get(`/api/v1/stock/valuation?date=${today()}&basis=${basis}`)).json() as {
      total: string;
      method: string;
      rows: { id: string; qty: string; price: string; value: string; costSource: string }[];
    };

  it('averages receipts at different prices, values sales and losses at the average', async () => {
    const p = await newProduct('900001');
    await t.db.transaction(async (tx) => {
      await recordMovement(tx, {
        productId: p.id,
        qtyMilli: 10_000,
        kind: 'PURCHASE_IN',
        unitCost: '5',
      });
      await recordMovement(tx, {
        productId: p.id,
        qtyMilli: 10_000,
        kind: 'PURCHASE_IN',
        unitCost: '7',
      });
    });
    let v = await valuation();
    expect(v.method).toBe('CMUP');
    expect(v.rows.find((r) => r.id === p.id)).toMatchObject({
      qty: '20.000',
      price: '6.0000',
      value: '120.00',
    });

    // A sale of 5 and a loss of 3 leave the average at 6 and are valued at it.
    await t.db.transaction(async (tx) => {
      await recordMovement(tx, { productId: p.id, qtyMilli: -5_000, kind: 'SALE' });
      await recordMovement(tx, { productId: p.id, qtyMilli: -3_000, kind: 'LOSS', unitCost: '99' });
    });
    v = await valuation();
    expect(v.rows.find((r) => r.id === p.id)).toMatchObject({
      qty: '12.000',
      price: '6.0000',
      value: '72.00',
    });

    // A third receipt: (12 x 6 + 8 x 9) / 20 = 7.2
    await t.db.transaction((tx) =>
      recordMovement(tx, { productId: p.id, qtyMilli: 8_000, kind: 'PURCHASE_IN', unitCost: '9' }),
    );
    v = await valuation();
    expect(v.rows.find((r) => r.id === p.id)).toMatchObject({
      qty: '20.000',
      price: '7.2000',
      value: '144.00',
    });
    expect(v.total).toBe('144.00');
  });

  it('is not moved by an edit of the purchase price or of the price history', async () => {
    const p = await newProduct('900002');
    await t.db.transaction((tx) =>
      recordMovement(tx, {
        productId: p.id,
        qtyMilli: 4_000,
        kind: 'PURCHASE_IN',
        unitCost: '2.5',
      }),
    );
    expect((await valuation()).total).toBe('10.00');
    await t.db.update(product).set({ purchasePriceExcl: '40.0000' }).where(eq(product.id, p.id));
    await t.db.insert(priceHistory).values({
      productId: p.id,
      purchasePriceExcl: '40.0000',
      purchasePriceIncl: '40.0000',
      salePrice: '9.00',
      source: 'FORM',
    });
    expect((await valuation()).total).toBe('10.00');
  });

  it('values a negative stock refilled by a receipt at the receipt cost', async () => {
    const p = await newProduct('900003');
    await t.db.transaction(async (tx) => {
      await recordMovement(tx, { productId: p.id, qtyMilli: -2_000, kind: 'SALE' });
      await recordMovement(tx, {
        productId: p.id,
        qtyMilli: 5_000,
        kind: 'PURCHASE_IN',
        unitCost: '3',
      });
    });
    const v = await valuation();
    expect(v.rows.find((r) => r.id === p.id)).toMatchObject({
      qty: '3.000',
      price: '3.0000',
      value: '9.00',
    });
  });
});
