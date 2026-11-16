import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { member, membershipType, seedMembershipTypes, supplier } from '@episoft/db';
import { appTimeZone } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// Lot A: the server guarantees the integrity of entries. An abnormal entry is refused with a field
// path and a French message (400/409), never a 500.

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

type Problem = { detail?: string; errors?: { path: string; message: string }[] };
const call = (
  h: Record<string, string>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: object,
) => t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });
const refused = (res: { statusCode: number; json: () => unknown }, status = 400) => {
  expect(res.statusCode).toBe(status);
  return res.json() as Problem;
};
const pathsOf = (p: Problem) => (p.errors ?? []).map((e) => e.path);

const newMember = {
  lastName: 'Dupont',
  firstName: 'Marie',
  street: null,
  postcode: null,
  communeId: null,
  phone: null,
  email: null,
  status: 'ACTIVE',
  publicVisible: false,
  newsletter: false,
  username: null,
  householdId: null,
};

describe('wallet and memberships at the back office', () => {
  let h: Record<string, string>;
  let householdId: string;
  beforeEach(async () => {
    await t.reset();
    await t.db.execute(sql`truncate app.wallet_entry, app.member_payment, app.membership cascade`);
    await seedMembershipTypes(t.db);
    h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    householdId = ((await call(h, 'POST', '/members', newMember)).json() as { householdId: string })
      .householdId;
  });

  it('refuses a date that does not exist or lies in the future', async () => {
    const p = refused(
      await call(h, 'POST', `/households/${householdId}/wallet/topup`, {
        amount: '10',
        method: 'CASH',
        date: '2026-02-30',
      }),
    );
    expect(pathsOf(p)).toContain('date');
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(
      pathsOf(
        refused(
          await call(h, 'POST', `/households/${householdId}/wallet/topup`, {
            amount: '10',
            method: 'CASH',
            date: future,
          }),
        ),
      ),
    ).toContain('date');
  });

  it('refuses a top-up above the ceiling', async () => {
    const p = refused(
      await call(h, 'POST', `/households/${householdId}/wallet/topup`, {
        amount: '1000.01',
        method: 'CASH',
      }),
    );
    expect(pathsOf(p)).toContain('amount');
  });

  it('refuses a correction above the ceiling, or without a reason', async () => {
    expect(
      pathsOf(
        refused(
          await call(h, 'POST', `/households/${householdId}/wallet/correction`, {
            amount: '600',
            comment: 'erreur',
          }),
        ),
      ),
    ).toContain('amount');
    expect(
      pathsOf(
        refused(
          await call(h, 'POST', `/households/${householdId}/wallet/correction`, {
            amount: '5',
            comment: ' ',
          }),
        ),
      ),
    ).toContain('comment');
  });

  it('keeps a correction above 100 euros for an administrator', async () => {
    const p = refused(
      await call(h, 'POST', `/households/${householdId}/wallet/correction`, {
        amount: '150',
        comment: 'erreur de saisie',
      }),
    );
    expect(pathsOf(p)).toEqual(['amount']);
    const admin = await login(
      t.app,
      (await createUser(t.db, { roles: ['ADHERENTS', 'ADMIN'] })).username!,
    );
    expect(
      (
        await call(admin, 'POST', `/households/${householdId}/wallet/correction`, {
          amount: '150',
          comment: 'erreur de saisie',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('forbids correcting the cagnotte of one own household (separation of duties)', async () => {
    const me = await createUser(t.db, { roles: ['ADHERENTS'] });
    await t.db.update(member).set({ householdId }).where(eq(member.id, me.id));
    const mine = await login(t.app, me.username!);
    const p = refused(
      await call(mine, 'POST', `/households/${householdId}/wallet/correction`, {
        amount: '2',
        comment: 'erreur de saisie',
      }),
    );
    expect(p.detail).toMatch(/propre foyer/);
    expect(pathsOf(p)).toContain('amount');
  });

  it('refuses a correction that pushes the cagnotte below the allowed overdraft', async () => {
    const p = refused(
      await call(h, 'POST', `/households/${householdId}/wallet/correction`, {
        amount: '-5',
        comment: 'erreur de saisie',
      }),
    );
    expect(p.detail).toMatch(/découvert/);
  });

  it('refuses a membership at another amount than the type, unless an administrator gives a reason', async () => {
    const [type] = await t.db
      .select()
      .from(membershipType)
      .where(eq(membershipType.code, 'ANNUAL'));
    const body = { typeId: type!.id, method: 'CASH', amount: '1.00' };
    expect(
      pathsOf(refused(await call(h, 'POST', `/households/${householdId}/memberships`, body))),
    ).toContain('amount');
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    expect(
      pathsOf(refused(await call(admin, 'POST', `/households/${householdId}/memberships`, body))),
    ).toContain('reason');
    expect(
      (
        await call(admin, 'POST', `/households/${householdId}/memberships`, {
          ...body,
          reason: 'Tarif solidaire décidé en réunion',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      pathsOf(
        refused(
          await call(h, 'POST', `/households/${householdId}/memberships`, {
            typeId: type!.id,
            method: 'CASH',
            date: '2026-02-30',
          }),
        ),
      ),
    ).toContain('date');
  });
});

describe('products and prices', () => {
  let h: Record<string, string>;
  beforeEach(async () => {
    await t.reset();
    await t.db.execute(sql`truncate app.product_barcode, app.price_history cascade`);
    await t.db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
    h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
  });
  const product = (extra: object = {}) => ({
    name: 'Lentilles',
    description: null,
    kind: 'GOODS',
    saleMode: 'UNIT',
    unitQty: null,
    unit: null,
    saleCondition: 'ON_SITE',
    shopVisible: true,
    categoryId: null,
    supplierId: null,
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
    code: '970001',
    ...extra,
  });

  it('refuses a purchase VAT amount that does not match the rate of the product', async () => {
    const p = refused(
      await call(
        h,
        'POST',
        '/products',
        product({ purchaseVatAmount: '0.9000', purchasePriceIncl: '10.9000' }),
      ),
    );
    expect(pathsOf(p)).toContain('purchasePriceIncl');
    expect(
      (
        await call(
          h,
          'POST',
          '/products',
          product({ purchaseVatAmount: '0.5500', purchasePriceIncl: '10.5500' }),
        )
      ).statusCode,
    ).toBe(200);
  });

  it('refuses a sale price of 0 for goods and a resale at a loss, except with a reason', async () => {
    expect(
      pathsOf(refused(await call(h, 'POST', '/products', product({ salePrice: '0.00' })))),
    ).toContain('salePrice');
    const loss = refused(await call(h, 'POST', '/products', product({ salePrice: '9.00' })));
    expect(pathsOf(loss)).toContain('salePrice');
    expect(loss.errors![0]!.message).toMatch(/revente à perte/);
    const ok = await call(
      h,
      'POST',
      '/products',
      product({ salePrice: '9.00', belowCostReason: 'Date courte, produit menacé' }),
    );
    expect(ok.statusCode).toBe(200);
    const audit = await t.db.execute<{ after: { belowCostReason?: string } }>(
      sql`select after from app.audit_log where action = 'product.create' order by at desc limit 1`,
    );
    expect(audit.rows[0]!.after.belowCostReason).toBe('Date courte, produit menacé');
  });

  it('applies the same rules to a modification', async () => {
    const created = (await call(h, 'POST', '/products', product())).json() as { id: string };
    const detail = (await call(h, 'GET', `/products/${created.id}`)).json() as {
      updatedAt: string;
    };
    const p = refused(
      await call(h, 'PATCH', `/products/${created.id}`, {
        salePrice: '5.00',
        updatedAt: detail.updatedAt,
      }),
    );
    expect(pathsOf(p)).toContain('salePrice');
  });

  it('refuses a price grid that sells below cost', async () => {
    const created = (await call(h, 'POST', '/products', product())).json() as { id: string };
    const p = refused(
      await call(h, 'POST', '/products/bulk-prices', {
        rows: [
          {
            productId: created.id,
            purchasePriceExcl: '10.0000',
            vatRate: '5.50',
            salePrice: '8.00',
            active: true,
          },
        ],
      }),
    );
    expect(pathsOf(p)).toEqual(['rows.0.salePrice']);
  });
});

describe('stock and receipts', () => {
  let h: Record<string, string>;
  beforeEach(async () => {
    await t.reset();
    await t.db
      .execute(sql`truncate app.invoice_receipt, app.supplier_invoice, app.goods_receipt_line,
      app.goods_receipt, app.purchase_order_line, app.purchase_order, app.stock_movement,
      app.price_history, app.number_counter, app.product_barcode cascade`);
    await t.db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
    await t.db.execute(sql`delete from app.supplier`);
    h = await login(t.app, (await createUser(t.db, { roles: ['APPROS', 'PRODUITS'] })).username!);
  });

  it('refuses a loss larger than the stock and a correction below zero', async () => {
    const p = await addProduct(t.db, { stockQty: '3' });
    const loss = refused(
      await call(h, 'POST', '/stock/losses', { productId: p.id, qty: '4', reason: 'casse' }),
    );
    expect(pathsOf(loss)).toEqual(['qty']);
    const corr = refused(
      await call(h, 'POST', '/stock/corrections', {
        productId: p.id,
        qty: '-3.5',
        comment: 'erreur',
      }),
    );
    expect(pathsOf(corr)).toEqual(['qty']);
    expect(
      (await call(h, 'POST', '/stock/losses', { productId: p.id, qty: '3', reason: 'casse' }))
        .statusCode,
    ).toBe(200);
  });

  async function orderOf(qty: string) {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FP', name: 'Fournisseur P' })
      .returning();
    const prod = await addProduct(t.db, {
      supplierId: s!.id,
      purchasePriceExcl: '10.0000',
      salePrice: '15.00',
    });
    const o = await call(h, 'POST', '/purchase-orders', {
      supplierId: s!.id,
      lines: [{ productId: prod.id, qty, unitPriceExcl: '10.0000' }],
    });
    const { id } = o.json() as { id: string };
    const detail = (await call(h, 'GET', `/purchase-orders/${id}`)).json() as {
      lines: { id: string }[];
    };
    return { id, productId: prod.id, lineId: detail.lines[0]!.id };
  }

  it('refuses to receive more than ordered, and the same line twice in a receipt', async () => {
    const o = await orderOf('5');
    const line = (qty: string) => ({
      orderLineId: o.lineId,
      productId: o.productId,
      qty,
      unitPriceExcl: '10.0000',
    });
    const over = refused(
      await call(h, 'POST', `/purchase-orders/${o.id}/receipts`, { lines: [line('6')] }),
    );
    expect(pathsOf(over)).toEqual(['lines.0.qty']);
    const twice = refused(
      await call(h, 'POST', `/purchase-orders/${o.id}/receipts`, {
        lines: [line('2'), line('2')],
      }),
    );
    expect(pathsOf(twice)).toEqual(['lines.1.orderLineId']);
    expect(
      (await call(h, 'POST', `/purchase-orders/${o.id}/receipts`, { lines: [line('5')] }))
        .statusCode,
    ).toBe(200);
    // Received in full: a second receipt of the line is refused.
    const again = await call(h, 'POST', `/purchase-orders/${o.id}/receipts`, {
      lines: [line('1')],
    });
    expect([400, 409]).toContain(again.statusCode);
  });

  it('refuses a new sale price below the purchase price on a receipt', async () => {
    const o = await orderOf('5');
    const p = refused(
      await call(h, 'POST', `/purchase-orders/${o.id}/receipts`, {
        lines: [
          {
            orderLineId: o.lineId,
            productId: o.productId,
            qty: '5',
            unitPriceExcl: '10.0000',
          },
        ],
        newSalePrices: { [o.productId]: '5.00' },
      }),
    );
    expect(pathsOf(p)).toEqual([`newSalePrices.${o.productId}`]);
  });

  it('refuses invoices with an impossible date, an excessive total or a due date before the invoice', async () => {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FQ', name: 'Fournisseur Q' })
      .returning();
    const inv = (extra: object) => ({
      supplierId: s!.id,
      pieceRef: 'F-1',
      date: '2026-03-10',
      totalExcl: '100.00',
      totalVat: '5.50',
      totalIncl: '105.50',
      paymentMethod: null,
      comment: null,
      receiptIds: [],
      ...extra,
    });
    expect(
      pathsOf(refused(await call(h, 'POST', '/supplier-invoices', inv({ date: '2026-02-30' })))),
    ).toContain('date');
    const big = refused(
      await call(
        h,
        'POST',
        '/supplier-invoices',
        inv({ totalExcl: '100000.01', totalVat: '0', totalIncl: '100000.01' }),
      ),
    );
    expect(pathsOf(big)).toContain('totalIncl');
    const early = refused(
      await call(h, 'POST', '/supplier-invoices', inv({ dueDate: '2026-03-01' })),
    );
    expect(pathsOf(early)).toContain('dueDate');
    expect((await call(h, 'POST', '/supplier-invoices', inv({}))).statusCode).toBe(200);
  });
});

describe('sales (a ticket already printed is never refused for a policy)', () => {
  let till: Till;
  beforeEach(async () => {
    till = await openTill(t);
  });

  it('rejects a discount larger than its line (arithmetic integrity)', async () => {
    const p = await addProduct(t.db, { salePrice: '2.50' });
    const [r] = await till.push([
      till.saleOp([{ productId: p.id, unitPrice: '2.50', discount: '3.00' }], '0.50'),
    ]);
    expect(r!.status).toBe('REJECTED');
    expect(r!.error).toMatch(/remise dépasse/i);
  });

  it('records a discount made while discounts are disabled as a blocking warning in À surveiller', async () => {
    const p = await addProduct(t.db, { salePrice: '2.50' });
    const [r] = await till.push([
      till.saleOp([{ productId: p.id, unitPrice: '2.50', discount: '0.50' }], '2.00'),
    ]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('POLICY_DISCOUNT');
    const attention = (await call(till.admin, 'GET', '/admin/attention')).json() as {
      code: string;
      count: number;
      severity: string;
    }[];
    expect(attention.find((a) => a.code === 'SALE_POLICY_BREACH')).toMatchObject({
      count: 1,
      severity: 'error',
    });
  });

  it('records a price different from the catalogue as a blocking warning', async () => {
    const p = await addProduct(t.db, { salePrice: '2.50' });
    const [r] = await till.push([
      till.saleOp([{ productId: p.id, unitPrice: '2.00', catalogPrice: '2.00' }], '2.00'),
    ]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.find((w) => w.code === 'PRICE_CHANGED')).toMatchObject({
      severity: 'blocking',
    });
  });
});

describe('time zone and undo', () => {
  it('refreshes the in-memory time zone when the undo restores the setting', async () => {
    await t.reset();
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    expect(
      (await call(admin, 'PUT', '/settings/app.timezone', { timeZone: 'Pacific/Auckland' }))
        .statusCode,
    ).toBe(200);
    expect(appTimeZone()).toBe('Pacific/Auckland');
    const entry = await t.db.execute<{ id: string }>(
      sql`select id from app.audit_log where action = 'setting.update' order by at desc limit 1`,
    );
    const res = await call(admin, 'POST', `/admin/audit/${entry.rows[0]!.id}/revert`, {
      reason: 'Fuseau saisi par erreur',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(appTimeZone()).toBe('Europe/Paris');
  });
});

describe('undo re-validates the values it puts back', () => {
  let admin: Record<string, string>;
  beforeEach(async () => {
    await t.reset();
    await t.db.execute(
      sql`truncate app.product_barcode, app.price_history, app.supplier_invoice cascade`,
    );
    await t.db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
    await t.db.execute(sql`delete from app.supplier`);
    admin = await login(
      t.app,
      (await createUser(t.db, { roles: ['ADMIN', 'PRODUITS', 'APPROS'] })).username!,
    );
  });
  const lastAudit = async (action: string) =>
    (
      await t.db.execute<{ id: string }>(
        sql`select id from app.audit_log where action = ${action} order by at desc limit 1`,
      )
    ).rows[0]!.id;

  it('refuses to restore an invalid product and leaves the current one untouched', async () => {
    const created = (
      await call(admin, 'POST', '/products', {
        name: 'Lentilles',
        description: null,
        kind: 'GOODS',
        saleMode: 'UNIT',
        unitQty: null,
        unit: null,
        saleCondition: 'ON_SITE',
        shopVisible: true,
        categoryId: null,
        supplierId: null,
        supplierRef: null,
        qualities: [],
        vatRate: '5.50',
        status: 'ACTIVE',
        purchasePriceExcl: '10.0000',
        purchaseVatAmount: '0.5500',
        purchasePriceIncl: '10.5500',
        salePrice: '15.00',
        minStock: null,
        eans: [],
        posTabId: null,
        posLabel: null,
        posSort: 0,
        code: '970002',
      })
    ).json() as { id: string };
    // An old inconsistent value (legacy data), then a valid correction through the API.
    await t.db.execute(
      sql`update app.product set purchase_vat_amount = 9, purchase_price_incl = 19 where id = ${created.id}`,
    );
    const detail = (await call(admin, 'GET', `/products/${created.id}`)).json() as {
      updatedAt: string;
    };
    expect(
      (
        await call(admin, 'PATCH', `/products/${created.id}`, {
          purchaseVatAmount: '0.5500',
          purchasePriceIncl: '10.5500',
          updatedAt: detail.updatedAt,
        })
      ).statusCode,
    ).toBe(200);
    const res = await call(
      admin,
      'POST',
      `/admin/audit/${await lastAudit('product.update')}/revert`,
      {
        reason: 'Retour en arrière',
      },
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as Problem).detail).toMatch(/Annulation refusée/);
    const row = await t.db.execute<{ v: string }>(
      sql`select purchase_vat_amount::text as v from app.product where id = ${created.id}`,
    );
    expect(Number(row.rows[0]!.v)).toBeCloseTo(0.55);
  });

  it('refuses to restore an invoice whose old totals are inconsistent', async () => {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: 'FR', name: 'Fournisseur R' })
      .returning();
    const body = (extra: object) => ({
      supplierId: s!.id,
      pieceRef: 'F-9',
      date: '2026-03-10',
      totalExcl: '100.00',
      totalVat: '5.50',
      totalIncl: '105.50',
      paymentMethod: null,
      comment: null,
      receiptIds: [],
      ...extra,
    });
    const { id } = (await call(admin, 'POST', '/supplier-invoices', body({}))).json() as {
      id: string;
    };
    await t.db.execute(sql`update app.supplier_invoice set total_incl = 500 where id = ${id}`);
    expect((await call(admin, 'PUT', `/supplier-invoices/${id}`, body({}))).statusCode).toBe(200);
    const res = await call(
      admin,
      'POST',
      `/admin/audit/${await lastAudit('invoice.update')}/revert`,
      {
        reason: 'Retour en arrière',
      },
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as Problem).detail).toMatch(/Annulation refusée/);
    const row = await t.db.execute<{ v: string }>(
      sql`select total_incl::text as v from app.supplier_invoice where id = ${id}`,
    );
    expect(Number(row.rows[0]!.v)).toBe(105.5);
  });
});
