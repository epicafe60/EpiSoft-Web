import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import type { AuditEntry, RevertPreview } from '@episoft/shared';
import { createPool } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct, openTill, resetTill } from './till-fixtures';

// R-ADM-05 (complete record of the changes) and R-ADM-06 (« Annuler cette action »).

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
let admin: Headers;
let adminId: string;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

beforeEach(async () => {
  await t.reset();
  await resetTill(t.db);
  const a = await createUser(t.db, {
    roles: ['ADMIN', 'PRODUITS', 'APPROS', 'ADHERENTS', 'COMPTA', 'CAISSE'],
  });
  adminId = a.id;
  admin = await login(t.app, a.username!);
});

const api = (method: string, url: string, payload?: object, h: Headers = admin) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: h, payload });

/** The journal entries, newest first. */
const journal = async () => (await api('GET', '/audit?limit=200')).json() as AuditEntry[];
const lastOf = async (action: string) => (await journal()).find((e) => e.action === action)!;
const preview = async (id: string) =>
  (await api('GET', `/admin/audit/${id}/revert`)).json() as RevertPreview;
const revert = (id: string, reason = 'erreur de saisie', h: Headers = admin) =>
  api('POST', `/admin/audit/${id}/revert`, { reason }, h);

const setting = async () =>
  ((await api('GET', '/settings')).json() as Record<string, { amount: string }>)[
    'pos.defaultFloat'
  ]!.amount;

describe('the complete record of the changes (R-ADM-05)', () => {
  it('records every row an action changed, with secrets masked', async () => {
    await api('PUT', '/settings/pos.defaultFloat', { amount: '80' });
    const e = await lastOf('setting.update');
    const changes = (await api('GET', `/admin/audit/${e.id}/changes`)).json() as {
      table: string;
      op: string;
      new: Record<string, unknown>;
    }[];
    expect(changes.map((c) => [c.table, c.op])).toEqual([
      ['setting', expect.stringMatching(/I|U/)],
    ]);

    // A password change: recorded, but the hash never appears.
    await t.db.execute(
      sql`update app.member set password_hash = 'secret-hash' where id = ${adminId}`,
    );
    const { rows } = await t.db.execute<{ old: unknown; new: unknown }>(
      sql`select old, new from app.data_change where table_name = 'member' and op = 'U' order by id desc limit 1`,
    );
    expect(JSON.stringify(rows[0])).not.toContain('secret-hash');
    expect(rows[0]!.new).toEqual({ password_hash: '***' });
  });

  it('does not record an update that changes nothing', async () => {
    const before = await t.db.execute(sql`select count(*)::int as n from app.data_change`);
    await t.db.execute(sql`update app.member set last_name = last_name where id = ${adminId}`);
    const after = await t.db.execute(sql`select count(*)::int as n from app.data_change`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('keeps the record append-only', async () => {
    await api('PUT', '/settings/pos.defaultFloat', { amount: '80' });
    await expect(t.db.execute(sql`delete from app.data_change`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/append-only/) },
    });
    await expect(t.db.execute(sql`update app.data_change set op = 'X'`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/append-only/) },
    });
  });

  it('every table of the schema records its changes (AUD-02)', async () => {
    const report = (await api('GET', '/admin/integrity')).json() as {
      checks: { id: string; count: number; samples: { ref: string }[] }[];
    };
    const aud2 = report.checks.find((c) => c.id === 'AUD-02')!;
    expect(aud2.samples).toEqual([]);
  });

  it('flags a change made directly in the database (AUD-01) and lists it', async () => {
    // Someone in psql: no application label on the connection.
    const manual = createPool(inject('databaseUrl'), 1, '');
    try {
      await manual.query(`update app.member set first_name = 'Bidouille' where id = $1`, [adminId]);
    } finally {
      await manual.end();
    }
    const report = (await api('GET', '/admin/integrity')).json() as {
      checks: { id: string; count: number; samples: { detail: string }[] }[];
    };
    const aud1 = report.checks.find((c) => c.id === 'AUD-01')!;
    expect(aud1.count).toBe(1);
    expect(aud1.samples[0]!.detail).toContain('directement dans la base');
    const listed = (await api('GET', '/admin/audit/unattributed')).json() as { tables: string[] }[];
    expect(listed).toEqual([expect.objectContaining({ tables: ['member'], source: null })]);
  });

  it('records signing in and the files handed out', async () => {
    expect((await journal()).some((e) => e.action === 'auth.login')).toBe(true);
    const file = await api('GET', '/members.xlsx');
    expect(file.statusCode).toBe(200);
    const audit = await api('GET', '/supply-audit.xlsx');
    expect(audit.statusCode).toBe(200);
    expect((await lastOf('export.file')).after).toEqual({
      file: 'audit-fournisseurs.xlsx',
      url: '/api/v1/supply-audit.xlsx',
    });
  });

  it('anonymising a member blanks what the journals recorded about them (R-MBR-08)', async () => {
    const m = await createUser(t.db, { roles: [] });
    const r = await api('GET', `/members/${m.id}`);
    const res = await api('PATCH', `/members/${m.id}`, {
      updatedAt: r.json().updatedAt,
      phone: '06 99 88 77 66',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await api('POST', `/members/${m.id}/anonymize`)).statusCode).toBe(200);
    const { rows } = await t.db.execute<{ j: string }>(sql`
      select coalesce(old::text, '') || coalesce(new::text, '') as j from app.data_change
      where table_name = 'member' and row_key ->> 'id' = ${m.id}
      union all
      select coalesce(before::text, '') || coalesce(after::text, '') from app.audit_log
      where entity = 'member' and entity_id = ${m.id}`);
    const all = rows.map((x) => x.j).join(' ');
    expect(all).not.toContain('06 99 88 77 66');
    expect(all).not.toContain(m.email!);
    expect(all).toContain('(anonymisé)');
  });
});

describe('undoing an action (R-ADM-06)', () => {
  it('puts a setting back, records the undo, refuses a second one, and can be undone itself', async () => {
    const was = await setting();
    await api('PUT', '/settings/pos.defaultFloat', { amount: '80' });
    const e = await lastOf('setting.update');

    const p = await preview(e.id);
    expect(p).toMatchObject({ kind: 'restore', possible: true, conflicts: [] });
    expect(p.steps).toHaveLength(1);
    expect(await setting()).toBe('80.00'); // the preview changed nothing

    const res = await revert(e.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await setting()).toBe(was);

    const undo = await lastOf('audit.revert');
    expect(undo).toMatchObject({ revertsId: e.id, after: { reason: 'erreur de saisie' } });
    expect((await journal()).find((x) => x.id === e.id)!.revertedBy).toMatchObject({ id: undo.id });

    const again = await revert(e.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().detail).toContain('déjà été annulée');

    // Undoing the undo puts the value of the action back.
    expect((await revert(undo.id, 'annulation par erreur')).statusCode).toBe(200);
    expect(await setting()).toBe('80.00');
    expect((await journal()).find((x) => x.id === e.id)!.revertedBy).toBeNull();
  });

  it('puts a price back and dates it in the price history', async () => {
    const p = await addProduct(t.db, { salePrice: '2.50' });
    const current = (await api('GET', `/products/${p.id}`)).json() as { updatedAt: string };
    const res = await api('PATCH', `/products/${p.id}`, {
      updatedAt: current.updatedAt,
      salePrice: '3.10',
    });
    expect(res.statusCode, res.body).toBe(200);
    const e = await lastOf('product.update');
    expect((await revert(e.id)).statusCode).toBe(200);
    const after = (await api('GET', `/products/${p.id}`)).json() as { salePrice: string };
    expect(after.salePrice).toBe('2.50');
    const { rows } = await t.db.execute<{ sale_price: string }>(
      sql`select sale_price::text from app.price_history where product_id = ${p.id} order by at`,
    );
    // The change and its undo: both kept.
    expect(rows.map((r) => r.sale_price)).toEqual(['3.10', '2.50']);
  });

  it('refuses when the record was changed since, and names the more recent action', async () => {
    const p = await addProduct(t.db, { salePrice: '2.50' });
    const change = async (price: string) => {
      const c = (await api('GET', `/products/${p.id}`)).json() as { updatedAt: string };
      const r = await api('PATCH', `/products/${p.id}`, {
        updatedAt: c.updatedAt,
        salePrice: price,
      });
      expect(r.statusCode, r.body).toBe(200);
      return lastOf('product.update');
    };
    const first = await change('3.00');
    const second = await change('3.50');

    const pv = await preview(first.id);
    expect(pv.possible).toBe(false);
    expect(pv.conflicts[0]).toMatchObject({
      table: 'product',
      kind: 'changed',
      columns: expect.arrayContaining(['sale_price']),
      by: { auditId: second.id },
    });
    expect((await revert(first.id)).statusCode).toBe(409);

    // Undo the most recent first, then the first one goes through.
    expect((await revert(second.id)).statusCode).toBe(200);
    expect((await revert(first.id)).statusCode).toBe(200);
    expect(
      ((await api('GET', `/products/${p.id}`)).json() as { salePrice: string }).salePrice,
    ).toBe('2.50');
  });

  it('refuses to remove something created by the action and used since', async () => {
    const u = await api('POST', '/universes', { code: '9', name: 'Divers', sort: 0 });
    expect(u.statusCode, u.body).toBe(200);
    const c = await api('POST', '/categories', {
      universeId: u.json().id,
      code: '91',
      name: 'Bazar',
      sort: 0,
    });
    expect(c.statusCode, c.body).toBe(200);
    const created = await lastOf('universe.create');
    const pv = await preview(created.id);
    expect(pv.possible).toBe(false);
    expect(pv.reason).toContain('utilisé ailleurs depuis');
    expect((await revert(created.id)).statusCode).toBe(409);
    const left = await t.db.execute(
      sql`select count(*)::int as n from app.universe where code = '9'`,
    );
    expect(left.rows[0]).toEqual({ n: 1 });
  });

  it('undoes a cagnotte correction with the opposite correction, never by deleting it', async () => {
    const m = await createUser(t.db, { roles: [] });
    const { rows } = await t.db.execute<{ id: string }>(
      sql`insert into app.household (id, referent_member_id) values (gen_random_uuid(), ${m.id}) returning id`,
    );
    const h = rows[0]!.id;
    const r = await api('POST', `/households/${h}/wallet/correction`, {
      amount: '12.00',
      comment: 'cadeau',
    });
    expect(r.statusCode, r.body).toBe(200);
    const e = await lastOf('wallet.correction');
    const pv = await preview(e.id);
    expect(pv).toMatchObject({ kind: 'compensate', possible: true });
    expect(pv.message).toContain('-12,00');
    expect((await revert(e.id, 'mauvais foyer')).statusCode).toBe(200);
    const entries = await t.db.execute<{ amount: string; kind: string; comment: string }>(
      sql`select amount::text, kind, comment from app.wallet_entry where household_id = ${h} order by created_at`,
    );
    expect(entries.rows.map((x) => [x.amount, x.kind])).toEqual([
      ['12.00', 'CORRECTION'],
      ['-12.00', 'CORRECTION'],
    ]);
    expect(entries.rows[1]!.comment).toContain('mauvais foyer');
  });

  it('undoes a stock loss with the opposite movement', async () => {
    const p = await addProduct(t.db, { stockQty: '10' });
    expect(
      (await api('POST', '/stock/losses', { productId: p.id, qty: '2', reason: 'cassé' }))
        .statusCode,
    ).toBe(200);
    const e = await lastOf('stock.loss');
    expect((await revert(e.id)).statusCode).toBe(200);
    const { rows } = await t.db.execute<{ stock_qty: string; n: number }>(sql`
      select p.stock_qty::text, (select count(*)::int from app.stock_movement s where s.product_id = p.id) as n
      from app.product p where p.id = ${p.id}`);
    expect(rows[0]).toEqual({ stock_qty: '10.000', n: 3 });
  });

  it('a ticket is cancelled from the till: the journal points there', async () => {
    const till = await openTill(t);
    const p = await addProduct(t.db, { stockQty: '5' });
    await till.push([till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50')]);
    const e = (
      (await (
        await t.app.inject({ url: '/api/v1/audit?limit=50', headers: till.admin })
      ).json()) as AuditEntry[]
    ).find((x) => x.action === 'sale.create')!;
    expect(e.after).toMatchObject({ total: '2.50' });
    const pv = (
      await t.app.inject({ url: `/api/v1/admin/audit/${e.id}/revert`, headers: till.admin })
    ).json() as RevertPreview;
    expect(pv).toMatchObject({ kind: 'via', possible: false, link: '/caisse/tickets' });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/audit/${e.id}/revert`,
      headers: till.admin,
      payload: { reason: 'test' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('a deletion is recorded row by row, cascade included, and undone parent first', async () => {
    const { rows } = await t.db.execute<{ id: string }>(
      sql`insert into app.supplier (id, code, name) values (gen_random_uuid(), 'FX', 'Fournisseur X') returning id`,
    );
    const supplierId = rows[0]!.id;
    await addProduct(t.db, {
      supplierId,
      stockQty: '0',
      minStock: '6',
      purchasePriceExcl: '5.0000',
    });
    await addProduct(t.db, {
      supplierId,
      stockQty: '1',
      minStock: '4',
      purchasePriceExcl: '2.0000',
    });
    const o = await api('POST', '/purchase-orders', { supplierId });
    expect(o.statusCode, o.body).toBe(200);
    const orderId = o.json().id as string;
    const lines = async () =>
      (
        await t.db.execute<{ product_id: string; qty_ordered: string }>(
          sql`select product_id, qty_ordered::text from app.purchase_order_line
              where order_id = ${orderId} order by product_id`,
        )
      ).rows;
    const before = await lines();
    expect(before).toHaveLength(2);

    expect((await api('DELETE', `/purchase-orders/${orderId}`)).statusCode).toBe(204);
    expect(await lines()).toEqual([]);
    const e = await lastOf('order.delete');
    // The lines deleted by the cascade are recorded too, with their values.
    const changes = (await api('GET', `/admin/audit/${e.id}/changes`)).json() as {
      table: string;
      op: string;
      old: Record<string, unknown>;
    }[];
    expect(
      changes
        .filter((c) => c.op === 'D')
        .map((c) => c.table)
        .sort(),
    ).toEqual(['purchase_order', 'purchase_order_line', 'purchase_order_line']);

    const pv = await preview(e.id);
    expect(pv.reason).toBeNull();
    expect(pv).toMatchObject({ kind: 'restore', possible: true });
    expect(pv.steps.map((s) => [s.table, s.kind])).toEqual([
      ['purchase_order', 'insert'],
      ['purchase_order_line', 'insert'],
      ['purchase_order_line', 'insert'],
    ]);
    expect((await revert(e.id)).statusCode).toBe(200);
    expect(await lines()).toEqual(before);
    const detail = await api('GET', `/purchase-orders/${orderId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ status: 'DRAFT', lines: [{}, {}] });
  });

  it('a deleted row is not created twice: refused when its key is taken again', async () => {
    const p = await addProduct(t.db);
    expect((await api('PUT', `/shop/favorites/${p.id}`)).statusCode).toBe(200);
    expect((await api('DELETE', `/shop/favorites/${p.id}`)).statusCode).toBe(200);
    const removed = await lastOf('favorite.remove');
    expect((await api('PUT', `/shop/favorites/${p.id}`)).statusCode).toBe(200);
    const pv = await preview(removed.id);
    expect(pv).toMatchObject({
      possible: false,
      conflicts: [
        {
          table: 'product_favorite',
          kind: 'exists',
          by: { sentence: 'a ajouté un produit à ses favoris' },
        },
      ],
    });
    expect((await revert(removed.id)).statusCode).toBe(409);
  });

  it('puts the roles of a user back', async () => {
    const u = await createUser(t.db, { roles: ['CAISSE'] });
    const res = await api('PUT', `/admin/users/${u.id}/roles`, { roles: ['CAISSE', 'COMPTA'] });
    expect(res.statusCode, res.body).toBe(200);
    expect((await revert((await lastOf('member.roles')).id)).statusCode).toBe(200);
    const { rows } = await t.db.execute<{ role_code: string }>(
      sql`select role_code from app.user_role where member_id = ${u.id}`,
    );
    expect(rows.map((r) => r.role_code)).toEqual(['CAISSE']);
  });

  it('a top-up entered today is withdrawn; one of a past day is corrected', async () => {
    const m = await createUser(t.db, { roles: [] });
    const { rows } = await t.db.execute<{ id: string }>(
      sql`insert into app.household (id, referent_member_id) values (gen_random_uuid(), ${m.id}) returning id`,
    );
    const h = rows[0]!.id;
    const top = (amount: string) =>
      api('POST', `/households/${h}/wallet/topup`, {
        amount,
        method: 'CHEQUE',
        emailReceipt: false,
      });
    expect((await top('20')).statusCode).toBe(200);
    const today = await lastOf('wallet.topup');
    expect(await preview(today.id)).toMatchObject({
      kind: 'compensate',
      label: 'Retirer le versement saisi aujourd’hui',
    });
    expect((await revert(today.id)).statusCode).toBe(200);
    const count = async () =>
      (
        await t.db.execute<{ n: number }>(
          sql`select count(*)::int as n from app.wallet_entry where household_id = ${h}`,
        )
      ).rows[0]!.n;
    expect(await count()).toBe(0);

    // A top-up of a past day: an opposite correction, the top-up stays.
    expect((await top('15')).statusCode).toBe(200);
    const past = await lastOf('wallet.topup');
    await t.db.execute(sql`set session_replication_role = replica`);
    await t.db.execute(
      sql`update app.audit_log set at = now() - interval '3 days' where id = ${past.id}`,
    );
    await t.db.execute(sql`set session_replication_role = origin`);
    expect(await preview(past.id)).toMatchObject({
      kind: 'compensate',
      label: 'Passer une correction de cagnotte du montant opposé',
    });
    expect((await revert(past.id)).statusCode).toBe(200);
    expect(await count()).toBe(2);
  });

  it('an anonymisation cannot be undone, and says why', async () => {
    const m = await createUser(t.db, { roles: [] });
    await api('POST', `/members/${m.id}/anonymize`);
    const pv = await preview((await lastOf('member.anonymize')).id);
    expect(pv).toMatchObject({ kind: 'none', possible: false });
    expect(pv.reason).toContain('RGPD');
  });

  it('is reserved to the administrators and needs a reason', async () => {
    await api('PUT', '/settings/pos.defaultFloat', { amount: '80' });
    const e = await lastOf('setting.update');
    const other = await login(
      t.app,
      (await createUser(t.db, { roles: ['ADHERENTS', 'COMPTA'] })).username!,
    );
    expect((await revert(e.id, 'motif', other)).statusCode).toBe(403);
    expect((await api('GET', `/admin/audit/${e.id}/revert`, undefined, other)).statusCode).toBe(
      403,
    );
    expect((await revert(e.id, '')).statusCode).toBe(400);
    expect((await api('GET', `/admin/audit/${randomUUID()}/revert`)).statusCode).toBe(404);
  });
});
