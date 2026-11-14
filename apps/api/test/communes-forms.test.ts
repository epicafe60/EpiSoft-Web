import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLog, commune, supplier } from '@episoft/db';
import type { RoleCode } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';

// A supplier or a member lives in a town that is not in the list yet (reported by a user), and a
// refused form says which field is wrong.

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`delete from app.supplier`);
});

const as = async (roles: RoleCode[]) => login(t.app, (await createUser(t.db, { roles })).username!);
const call = (h: Record<string, string>, method: 'POST', url: string, payload: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: h, payload });

describe('POST /communes', () => {
  it('adds a town, journals it, and refuses the same town twice', async () => {
    const h = await as(['APPROS']);
    const r = await call(h, 'POST', '/communes', { postcode: '60240', name: '  Le  Vaumain ' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ postcode: '60240', name: 'Le Vaumain' });
    const rows = await t.db.select().from(commune).where(eq(commune.postcode, '60240'));
    expect(rows.map((c) => c.name)).toContain('Le Vaumain');
    const log = await t.db.select().from(auditLog).where(eq(auditLog.action, 'commune.create'));
    expect(log).toHaveLength(1);
    // Same town, any case: refused. The same name with another postcode is a different town.
    expect(
      (await call(h, 'POST', '/communes', { postcode: '60240', name: 'le vaumain' })).statusCode,
    ).toBe(409);
    expect(
      (await call(h, 'POST', '/communes', { postcode: '60241', name: 'Le Vaumain' })).statusCode,
    ).toBe(200);
  });

  it('wants 5 digits and a name, and a role', async () => {
    const h = await as(['APPROS']);
    const bad = await call(h, 'POST', '/communes', { postcode: '6024', name: 'X' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors).toEqual([{ path: 'postcode', message: 'Code postal à 5 chiffres.' }]);
    expect((await call(h, 'POST', '/communes', { postcode: '60240', name: ' ' })).statusCode).toBe(
      400,
    );
    const nobody = await as(['CAISSE']);
    expect(
      (await call(nobody, 'POST', '/communes', { postcode: '60240', name: 'Y' })).statusCode,
    ).toBe(403);
  });

  it('the new town can be given to a new supplier', async () => {
    const h = await as(['APPROS']);
    const town = (await call(h, 'POST', '/communes', { postcode: '60240', name: 'Boury' })).json();
    const r = await call(h, 'POST', '/suppliers', {
      name: 'Ferme de Boury',
      region: '60',
      postcode: '60240',
      communeId: town.id,
      contact: null,
      street: null,
      phone: null,
      email: null,
      website: null,
      priceListUrl: null,
      active: true,
      publicNotes: null,
      privateNotes: null,
      referentMemberId: null,
      sendsPo: true,
      accountNumber: null,
      minOrderAmount: null,
      paymentTermsDays: 30,
      deliveryDay: null,
    });
    expect(r.statusCode).toBe(200);
    const [s] = await t.db.select().from(supplier).where(eq(supplier.id, r.json().id));
    expect(s).toMatchObject({ postcode: '60240', communeId: town.id });
  });
});

describe('a refused form says which field', () => {
  it('a supplier with a bad postcode, a product without a selling price or with a wrong EAN', async () => {
    const h = await as(['APPROS', 'PRODUITS']);
    const s = await call(h, 'POST', '/suppliers', { name: 'X', postcode: '6024O' });
    expect(s.statusCode).toBe(400);
    expect(s.json().errors.map((e: { path: string }) => e.path)).toContain('postcode');
    const p = await call(h, 'POST', '/products', { name: 'Chips', salePrice: '', eans: ['123'] });
    expect(p.statusCode).toBe(400);
    const paths = p.json().errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['salePrice', 'eans']));
  });
});
