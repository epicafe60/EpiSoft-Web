import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { product } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

// A product of type « service » (a membership, a donation) is sold one at a time, in euros: no
// quantity and no unit of weight or volume, whatever the form, a file or a client sends.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
});

let n = 900000;
const body = (over: Record<string, unknown> = {}) => ({
  name: 'Produit de test',
  description: '',
  kind: 'GOODS',
  saleMode: 'WEIGHT',
  unitQty: '500',
  unit: 'G',
  saleCondition: 'ON_SITE',
  shopVisible: true,
  categoryId: null,
  supplierId: null,
  supplierRef: '',
  qualities: [],
  vatRate: '5.50',
  status: 'ACTIVE',
  purchasePriceExcl: null,
  salePrice: '10.00',
  minStock: null,
  eans: [],
  posTabId: null,
  posLabel: '',
  posSort: 0,
  code: String(++n),
  ...over,
});

const create = async (over: Record<string, unknown> = {}) => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/products',
    headers: h,
    payload: body(over),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; code: string };
};
const row = async (id: string) => (await t.db.select().from(product).where(eq(product.id, id)))[0]!;
const detail = async (id: string) =>
  (await t.app.inject({ url: `/api/v1/products/${id}`, headers: h })).json();
const patch = (id: string, updatedAt: string, payload: Record<string, unknown>) =>
  t.app.inject({
    method: 'PATCH',
    url: `/api/v1/products/${id}`,
    headers: h,
    payload: { ...payload, updatedAt },
  });

describe('creating a service', () => {
  it('is saved one at a time with a quantity of 1 and no unit, whatever was sent', async () => {
    const { id } = await create({ kind: 'SERVICE', name: 'Cotisation' });
    const p = await row(id);
    expect(p).toMatchObject({ kind: 'SERVICE', saleMode: 'UNIT', unit: null });
    expect(Number(p.unitQty)).toBe(1);
  });

  it('leaves the choices of a goods product alone', async () => {
    const { id } = await create({ kind: 'GOODS', name: 'Lentilles en vrac' });
    const p = await row(id);
    expect(p).toMatchObject({ kind: 'GOODS', saleMode: 'WEIGHT', unit: 'G' });
    expect(Number(p.unitQty)).toBe(500);
  });

  it('does not need a quantity or a unit to be sent', async () => {
    const { id } = await create({
      kind: 'SERVICE',
      name: 'Don',
      saleMode: 'UNIT',
      unitQty: null,
      unit: null,
    });
    expect(Number((await row(id)).unitQty)).toBe(1);
  });
});

describe('changing a product', () => {
  it('turning a goods product into a service fixes its terms', async () => {
    const { id } = await create({ name: 'Au poids' });
    const before = await detail(id);
    expect((await patch(id, before.updatedAt, { kind: 'SERVICE' })).statusCode).toBe(200);
    const p = await row(id);
    expect(p).toMatchObject({ kind: 'SERVICE', saleMode: 'UNIT', unit: null });
    expect(Number(p.unitQty)).toBe(1);
  });

  it('a service refuses to take a unit back, even when asked for one', async () => {
    const { id } = await create({ kind: 'SERVICE', name: 'Adhésion' });
    const before = await detail(id);
    const res = await patch(id, before.updatedAt, { unit: 'KG', unitQty: '2', saleMode: 'WEIGHT' });
    expect(res.statusCode).toBe(200);
    const p = await row(id);
    expect(p).toMatchObject({ saleMode: 'UNIT', unit: null });
    expect(Number(p.unitQty)).toBe(1);
  });

  it('turning a service back into goods lets the terms be chosen again', async () => {
    const { id } = await create({ kind: 'SERVICE', name: 'Redevient un produit' });
    const before = await detail(id);
    const res = await patch(id, before.updatedAt, {
      kind: 'GOODS',
      saleMode: 'VOLUME',
      unitQty: '75',
      unit: 'ML',
    });
    expect(res.statusCode).toBe(200);
    const p = await row(id);
    expect(p).toMatchObject({ kind: 'GOODS', saleMode: 'VOLUME', unit: 'ML' });
    expect(Number(p.unitQty)).toBe(75);
  });

  it('changing something else on a service does not touch its terms', async () => {
    const { id } = await create({ kind: 'SERVICE', name: 'Cotisation' });
    const before = await detail(id);
    expect((await patch(id, before.updatedAt, { salePrice: '12.00' })).statusCode).toBe(200);
    const p = await row(id);
    expect(p.salePrice).toBe('12.00');
    expect(p).toMatchObject({ saleMode: 'UNIT', unit: null });
  });
});
