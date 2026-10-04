import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { householdBalance, importLog, member, product, stockMovement } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

// Annexe D layout: 24 columns, only the used ones filled.
function productLine(o: { code: string; name: string; pa: string; pv: string; stock: string }) {
  const c = Array.from({ length: 24 }, () => '');
  c[0] = '1';
  c[1] = o.name;
  c[2] = o.code;
  c[4] = o.pa;
  c[5] = 'HT';
  c[6] = '5,5';
  c[8] = o.pv;
  c[17] = o.stock;
  return c.join(';');
}
const HEADER = Array.from({ length: 24 }, (_, i) => `C${i}`).join(';');

async function post(path: string, body: string, headers: Record<string, string>) {
  return t.app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    payload: Buffer.from(body, 'utf-8'),
    headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': 'p.csv' },
  });
}

describe('product import (R-IMP-01, R-IMP-04)', () => {
  it('previews, creates, is idempotent, and corrects stock instead of overwriting it', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
    const file = [
      HEADER,
      productLine({ code: 'IMP1', name: 'Miel', pa: '3,00', pv: '5,00', stock: '10' }),
      productLine({ code: 'IMP2', name: 'Confiture', pa: '2,00', pv: '4,00', stock: '' }),
    ].join('\n');

    const preview = await post('/imports/products/preview', file, h);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().counts).toMatchObject({ create: 2, error: 0 });
    expect(await t.db.select().from(product).where(eq(product.code, 'IMP1'))).toHaveLength(0);

    const applied = await post('/imports/products/apply', file, h);
    expect(applied.json()).toMatchObject({ created: 2 });
    const [miel] = await t.db.select().from(product).where(eq(product.code, 'IMP1'));
    expect(miel).toMatchObject({ salePrice: '5.00', stockQty: '10.000' });

    // Replaying the same file changes nothing.
    const again = await post('/imports/products/preview', file, h);
    expect(again.json().counts).toMatchObject({ create: 0, update: 0, unchanged: 2 });

    // New prices and stock: only the chosen fields are applied; stock becomes a CORRECTION.
    const next = [
      HEADER,
      productLine({ code: 'IMP1', name: 'Miel', pa: '3,00', pv: '6,00', stock: '7' }),
    ].join('\n');
    const upd = await post('/imports/products/apply?fields=stock', next, h);
    expect(upd.json()).toMatchObject({ updated: 1, stockCorrections: 1 });
    const [after] = await t.db.select().from(product).where(eq(product.code, 'IMP1'));
    expect(after).toMatchObject({ salePrice: '5.00', stockQty: '7.000' });
    const moves = await t.db.select().from(stockMovement).where(eq(stockMovement.productId, after!.id));
    expect(moves.find((m) => m.kind === 'CORRECTION')?.qty).toBe('-3.000');

    expect((await t.db.select().from(importLog)).length).toBe(2);
  });

  it('is limited to PRODUITS and reports invalid rows', async () => {
    const till = await login(t.app, (await createUser(t.db, { roles: ['CAISSE'] })).username!);
    expect((await post('/imports/products/preview', 'x', till)).statusCode).toBe(403);
    const h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
    const bad = [HEADER, productLine({ code: '', name: 'X', pa: '', pv: '', stock: '' })].join('\n');
    expect((await post('/imports/products/preview', bad, h)).json().counts.error).toBe(1);
  });
});

describe('member import (R-IMP-02)', () => {
  it('creates members and corrects, never adds, the balance after confirmation', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const row = (bal: string) => {
      const c = Array.from({ length: 14 }, () => '');
      c[1] = bal;
      c[2] = 'Anne';
      c[3] = 'Dupont';
      c[6] = 'anne@example.org';
      return c.join(';');
    };
    const header = Array.from({ length: 14 }, (_, i) => `H${i}`).join(';');

    const apply = (bal: string, confirm: boolean) =>
      post(`/imports/members/apply?confirmBalance=${confirm}`, `${header}\n${row(bal)}`, h);
    expect((await apply('20,00', true)).json()).toMatchObject({ created: 1, balanceCorrections: 1 });
    const [m] = await t.db.select().from(member).where(eq(member.email, 'anne@example.org'));
    const balance = async () =>
      (await t.db.select().from(householdBalance).where(eq(householdBalance.householdId, m!.householdId!)))[0]!.balance;
    expect(await balance()).toBe('20.00');

    // Same file again: the balance already matches, nothing is added.
    expect((await apply('20,00', true)).json()).toMatchObject({ created: 0, balanceCorrections: 0 });
    expect(await balance()).toBe('20.00');

    // A different balance is only applied when confirmed, as a correction of the gap.
    await apply('25,00', false);
    expect(await balance()).toBe('20.00');
    await apply('25,00', true);
    expect(await balance()).toBe('25.00');
  });
});
