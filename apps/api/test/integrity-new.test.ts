import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailOutbox } from '@episoft/db';
import type { SyncOp } from '@episoft/shared';
import { takeWalletSnapshot } from '../src/modules/members/wallet-snapshot';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct as addProductTo, openTill, type Till } from './till-fixtures';

// The new integrity checks: each one catches a corrupted case, then is quiet once repaired.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
let till: Till;
let cashier: Headers;
let admin: Headers;
let sessionId: string;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

beforeEach(async () => {
  till = await openTill(t);
  ({ cashier, admin, sessionId } = till);
});

const push = (ops: SyncOp[]) => till.push(ops);
const saleOp = (...args: Parameters<Till['saleOp']>) => till.saleOp(...args);
const addProduct = (over: Parameters<typeof addProductTo>[1] = {}) => addProductTo(t.db, over);

const get = (url: string, h: Headers = admin) => t.app.inject({ url: `/api/v1${url}`, headers: h });
const post = (url: string, payload: object = {}, h: Headers = admin) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

const count = async (id: string) => {
  const report = (await get('/admin/integrity')).json() as {
    checks: { id: string; count: number }[];
  };
  return report.checks.find((c) => c.id === id)!.count;
};

describe('the new integrity checks', () => {
  it('SYN-01: a refused ticket is an error until it is put aside', async () => {
    expect(await count('SYN-01')).toBe(0);
    await push([saleOp([{ productId: randomUUID(), unitPrice: '2.50' }], '2.50')]);
    expect(await count('SYN-01')).toBe(1);
    const [r] = (await get('/admin/rejections')).json() as { id: string }[];
    await post(`/admin/rejections/${r!.id}/ack`);
    expect(await count('SYN-01')).toBe(0);
  });

  it('SES-01: a session left open for more than a day', async () => {
    expect(await count('SES-01')).toBe(0);
    await t.db.execute(
      sql`update app.cash_session set opened_at = now() - interval '2 days' where id = ${sessionId}`,
    );
    expect(await count('SES-01')).toBe(1);
    await t.db.execute(sql`update app.cash_session set opened_at = now() where id = ${sessionId}`);
    expect(await count('SES-01')).toBe(0);
  });

  it('SES-02: a ticket that reaches the server after the closing', async () => {
    const p = await addProduct({ stockQty: '50' });
    await push([saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    const close = await post(
      `/pos/sessions/${sessionId}/close`,
      {
        denominations: { '5000': 2, '200': 1, '50': 1 },
        bankDeposit: '0',
        chequesCount: 0,
        chequesTotal: '0',
        cardTotalDeclared: '0',
      },
      cashier,
    );
    expect(close.statusCode, close.body).toBe(200);
    expect(await count('SES-02')).toBe(0);
    // A ticket made before the closing, sent after: recorded, but the closing no longer adds up.
    const [late] = await push([saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    expect(late!.warnings.map((w) => w.code)).toContain('SESSION_CLOSED');
    expect(await count('SES-02')).toBe(1);
  });

  it('VTE-06: a ticket with a warning is listed until it has been seen', async () => {
    const p = await addProduct({ stockQty: '500' });
    await push([saleOp([{ productId: p.id, qty: '100', unitPrice: '2.50' }], '250.00')]);
    expect(await count('VTE-06')).toBe(1);
    const [w] = (await get('/admin/sale-warnings')).json() as { id: string }[];
    await post(`/admin/sale-warnings/${w!.id}/review`);
    expect(await count('VTE-06')).toBe(0);
  });

  it('MEM-01: two cards with the same name', async () => {
    await t.db.execute(sql`insert into app.member (id, first_name, last_name, status)
      values (gen_random_uuid(), 'Marie', 'Dupont', 'ACTIVE')`);
    expect(await count('MEM-01')).toBe(0);
    await t.db.execute(sql`insert into app.member (id, first_name, last_name, status)
      values (gen_random_uuid(), 'MARIE', 'dupont', 'ACTIVE')`);
    expect(await count('MEM-01')).toBe(1);
    await t.db.execute(sql`update app.member set status = 'ARCHIVED' where first_name = 'MARIE'`);
    expect(await count('MEM-01')).toBe(0);
  });

  it('CAG-05: a movement slipped into the past after the balances were noted', async () => {
    const [h] = (
      await t.db.execute(
        sql`insert into app.household (id) values (gen_random_uuid()) returning id`,
      )
    ).rows as { id: string }[];
    await t.db.execute(sql`insert into app.wallet_entry (id, household_id, amount, kind)
      values (gen_random_uuid(), ${h!.id}, 20, 'CORRECTION')`);
    // Noted « tomorrow morning »: today's 20 € are in the balance of that morning.
    const tomorrow = new Date(Date.now() + 36 * 3_600_000);
    expect(await takeWalletSnapshot(t.db, tomorrow)).toBe(1);
    expect(await takeWalletSnapshot(t.db, tomorrow)).toBe(0); // one note per day
    expect(await count('CAG-05')).toBe(0);

    // A movement written « in the past » (recorded before the snapshot, but absent from it).
    await t.db.execute(sql`insert into app.wallet_entry (id, household_id, amount, kind, created_at)
      values (gen_random_uuid(), ${h!.id}, 5, 'CORRECTION', now() - interval '3 hours')`);
    expect(await count('CAG-05')).toBe(1);
    await t.db.execute(sql`delete from app.wallet_entry where amount = 5`);
    expect(await count('CAG-05')).toBe(0);

    // An old movement whose amount was changed afterwards.
    await t.db.execute(sql`update app.wallet_entry set amount = 25 where household_id = ${h!.id}`);
    expect(await count('CAG-05')).toBe(1);
    await t.db.execute(sql`update app.wallet_entry set amount = 20 where household_id = ${h!.id}`);
    expect(await count('CAG-05')).toBe(0);
  });

  it('CAG-05: a ticket sold offline yesterday evening and received this morning is not an error', async () => {
    const [h] = (
      await t.db.execute(
        sql`insert into app.household (id) values (gen_random_uuid()) returning id`,
      )
    ).rows as { id: string }[];
    await t.db
      .execute(sql`insert into app.wallet_entry (id, household_id, amount, kind, at, created_at)
      values (gen_random_uuid(), ${h!.id}, 20, 'CORRECTION', now() - interval '3 days', now() - interval '3 days')`);
    // This morning's note of the balances.
    expect(await takeWalletSnapshot(t.db, new Date())).toBe(1);
    // Then the till comes back online: the sale is dated yesterday 23:50, recorded now.
    await t.db.execute(sql`insert into app.wallet_entry (id, household_id, amount, kind, at)
      values (gen_random_uuid(), ${h!.id}, -3, 'PURCHASE',
        (date_trunc('day', now() at time zone 'Europe/Paris') - interval '10 minutes') at time zone 'Europe/Paris')`);
    expect(await count('CAG-05')).toBe(0);
  });

  it('REF-01: a row that points to something deleted with the constraints bypassed', async () => {
    expect(await count('REF-01')).toBe(0);
    const ghost = randomUUID();
    // What a manual data load can do: the foreign key is not checked while triggers are off.
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      // Closed: the shop has a single open session at a time (R-SES-05).
      await tx.execute(sql`insert into app.cash_session (id, device_id, opened_at, opening_float, status)
        values (gen_random_uuid(), ${ghost}, now(), 0, 'CLOSED')`);
    });
    expect(await count('REF-01')).toBe(1);
    const report = (await get('/admin/integrity')).json() as {
      checks: { id: string; samples: { ref: string; detail: string }[] }[];
    };
    const sample = report.checks.find((c) => c.id === 'REF-01')!.samples[0]!;
    expect(sample.ref).toBe('app.cash_session → app.pos_device');
    expect(sample.detail).toContain('1 ligne(s) orpheline(s)');

    // Repaired by recreating the missing till: nothing to report any more.
    await t.db.execute(sql`insert into app.pos_device (id, name) values (${ghost}, 'RETROUVÉ')`);
    expect(await count('REF-01')).toBe(0);
  });

  it('MAIL-01: an e-mail that failed this week', async () => {
    expect(await count('MAIL-01')).toBe(0);
    await t.db.insert(emailOutbox).values({
      to: 'x@example.org',
      subject: 'Raté',
      html: '',
      status: 'FAILED',
      lastError: 'SMTP down',
    });
    expect(await count('MAIL-01')).toBe(1);
    await t.db.execute(sql`update app.email_outbox set status = 'SENT'`);
    expect(await count('MAIL-01')).toBe(0);
  });

  it('BKP-01: no recent backup, then one is reported', async () => {
    expect(await count('BKP-01')).toBe(1);
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/internal/backup-report',
      headers: { 'x-episoft-csrf': '1', authorization: 'Bearer test-backup-token-0123456789' },
      payload: { kind: 'BACKUP', ok: true },
    });
    expect(await count('BKP-01')).toBe(0);
  });

  it('FAC-02: an invoice far from the receipts it covers', async () => {
    const [s] = (
      await t.db.execute(
        sql`insert into app.supplier (id, code, name) values (gen_random_uuid(), 'FQ', 'Fournisseur Q') returning id`,
      )
    ).rows as { id: string }[];
    const editor = await login(
      t.app,
      (await createUser(t.db, { roles: ['APPROS', 'PRODUITS', 'COMPTA'] })).username!,
    );
    const created = await post(
      '/products',
      {
        name: 'Facturé',
        description: null,
        kind: 'GOODS',
        saleMode: 'UNIT',
        unitQty: null,
        unit: null,
        saleCondition: 'ON_SITE',
        shopVisible: true,
        categoryId: null,
        supplierId: s!.id,
        supplierRef: null,
        qualities: [],
        vatRate: '5.50',
        status: 'ACTIVE',
        purchasePriceExcl: '10.0000',
        salePrice: '15.00',
        minStock: null,
        eans: [],
        posTabId: null,
        posLabel: null,
        posSort: 0,
        code: '980001',
      },
      editor,
    );
    const { id: productId } = created.json() as { id: string };
    const rec = await post(
      '/receipts',
      {
        supplierId: s!.id,
        lines: [{ orderLineId: null, productId, qty: '10', unitPriceExcl: '10.0000' }],
      },
      editor,
    );
    expect(rec.statusCode, rec.body).toBe(200);
    const { id: receiptId } = rec.json() as { id: string };
    // 10 × 10 € HT + 5,5 % = 105,50 €. An old invoice for 150 € covering it:
    const bad = await post(
      '/supplier-invoices',
      {
        supplierId: s!.id,
        pieceRef: 'Q-1',
        date: '2026-01-10',
        totalExcl: '142.18',
        totalVat: '7.82',
        paymentMethod: null,
        comment: null,
        receiptIds: [receiptId],
      },
      editor,
    );
    expect(bad.statusCode, bad.body).toBe(200);
    expect(await count('FAC-02')).toBe(1);
    await t.db.execute(sql`delete from app.invoice_receipt`);
    await t.db.execute(sql`delete from app.supplier_invoice where piece_ref = 'Q-1'`);
    const good = await post(
      '/supplier-invoices',
      {
        supplierId: s!.id,
        pieceRef: 'Q-2',
        date: '2026-01-11',
        totalExcl: '100.00',
        totalVat: '5.50',
        paymentMethod: null,
        comment: null,
        receiptIds: [receiptId],
      },
      editor,
    );
    expect(good.statusCode, good.body).toBe(200);
    expect(await count('FAC-02')).toBe(0);
  });
});
