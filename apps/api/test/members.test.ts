import ExcelJS from 'exceljs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  productReview,
  pushSubscription,
  auditLog,
  category,
  householdBalance,
  member,
  membership,
  priceHistory,
  product,
  seedMembershipTypes,
  universe,
  userRole,
} from '@episoft/db';
import { sha256Hex } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let headers: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(
    sql`truncate app.wallet_entry, app.member_payment, app.membership, app.product_barcode, app.price_history, app.category, app.universe cascade`,
  );
  await t.db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
  await seedMembershipTypes(t.db);
  const u = await createUser(t.db, { roles: ['ADHERENTS', 'PRODUITS'] });
  headers = await login(t.app, u.username!);
});

const newMember = {
  lastName: 'Dupont',
  firstName: 'Marie',
  street: '1 rue Haute',
  postcode: '60240',
  communeId: null,
  phone: '06 12 34 56 78',
  email: 'marie@example.org',
  status: 'ACTIVE',
  publicVisible: false,
  newsletter: true,
  username: null,
  householdId: null,
};

const post = (url: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, headers, payload: payload as object });
const patch = (url: string, payload: unknown) =>
  t.app.inject({ method: 'PATCH', url, headers, payload: payload as object });
const get = (url: string) => t.app.inject({ url, headers });

describe('members and households (R-MBR-01, R-MBR-02)', () => {
  it('creates a member as referent of a new household, with a badge token', async () => {
    const res = await post('/api/v1/members', newMember);
    expect(res.statusCode).toBe(200);
    const { id, householdId, qrToken } = res.json();
    expect(qrToken.length).toBeGreaterThanOrEqual(15);
    const [m] = await t.db.select().from(member).where(eq(member.id, id));
    expect(m!.qrTokenHash).toBe(await sha256Hex(qrToken));
    expect(m!.newsletterOptInAt).not.toBeNull();
    const h = (await get(`/api/v1/households/${householdId}`)).json();
    expect(h).toMatchObject({ referentMemberId: id, balance: '0.00' });

    const second = await post('/api/v1/members', {
      ...newMember,
      firstName: 'Paul',
      email: null,
      householdId,
    });
    expect(second.json().householdId).toBe(householdId);
  });

  it('refuses a duplicate e-mail', async () => {
    await post('/api/v1/members', newMember);
    const res = await post('/api/v1/members', { ...newMember, firstName: 'Autre' });
    expect(res.statusCode).toBe(409);
  });

  it('CA §4.2: changing the phone of a cashier keeps the CAISSE role (R-MBR-09)', async () => {
    const { id } = (await post('/api/v1/members', newMember)).json();
    await t.db.insert(userRole).values({ memberId: id, roleCode: 'CAISSE' });
    const loaded = (await get(`/api/v1/members/${id}`)).json();
    const res = await patch(`/api/v1/members/${id}`, {
      phone: '07 00 00 00 00',
      updatedAt: loaded.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    const after = (await get(`/api/v1/members/${id}`)).json();
    expect(after).toMatchObject({
      phone: '07 00 00 00 00',
      street: '1 rue Haute',
      roles: ['CAISSE'],
    });
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'member.update'));
    expect(entry!.after).toEqual({ phone: '07 00 00 00 00' });
  });

  it('detects concurrent edits (409)', async () => {
    const { id } = (await post('/api/v1/members', newMember)).json();
    const loaded = (await get(`/api/v1/members/${id}`)).json();
    expect(
      (await patch(`/api/v1/members/${id}`, { phone: '1', updatedAt: loaded.updatedAt }))
        .statusCode,
    ).toBe(200);
    expect(
      (await patch(`/api/v1/members/${id}`, { phone: '2', updatedAt: loaded.updatedAt }))
        .statusCode,
    ).toBe(409);
  });

  it('CA §4.2: more than 127 members can be created (anomaly C13)', async () => {
    for (let i = 0; i < 130; i++) {
      await t.db.insert(member).values({ firstName: 'X', lastName: `N${i}` });
    }
    const [{ n }] = (await t.db.select({ n: sql<number>`count(*)::int` }).from(member)) as [
      { n: number },
    ];
    expect(n).toBeGreaterThan(130);
  });

  it('searches without accents, by number, phone digits and badge (R-MBR-06)', async () => {
    const { id, qrToken } = (
      await post('/api/v1/members', { ...newMember, lastName: 'Dupré', firstName: 'Hélène' })
    ).json();
    const [m] = await t.db.select().from(member).where(eq(member.id, id));
    for (const q of ['helene dupre', 'DUPRE', String(m!.number), '0612345678', qrToken]) {
      const res = (await get(`/api/v1/members?q=${encodeURIComponent(q)}`)).json();
      expect(
        res.map((r: { id: string }) => r.id),
        q,
      ).toContain(id);
    }
  });

  it('anonymises at archiving and keeps the household (R-MBR-08)', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const ah = await login(t.app, admin.username!);
    const { id } = (await post('/api/v1/members', newMember)).json();
    const [prod] = await t.db
      .insert(product)
      .values({ code: 'RG1', name: 'Miel', salePrice: '5' })
      .returning();
    await t.db
      .insert(productReview)
      .values({ productId: prod!.id, memberId: id, rating: 5, comment: 'Super' });
    await t.db
      .insert(pushSubscription)
      .values({ memberId: id, endpoint: 'https://push.example/x', p256dh: 'k', auth: 'a' });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/members/${id}/anonymize`,
      headers: ah,
    });
    expect(res.statusCode).toBe(200);
    const [m] = await t.db.select().from(member).where(eq(member.id, id));
    expect(m).toMatchObject({
      lastName: `Membre #${m!.number}`,
      email: null,
      phone: null,
      status: 'ARCHIVED',
    });
    // Free-text reviews and registered devices are removed with the identity.
    expect(await t.db.select().from(productReview).where(eq(productReview.memberId, id))).toEqual(
      [],
    );
    expect(
      await t.db.select().from(pushSubscription).where(eq(pushSubscription.memberId, id)),
    ).toEqual([]);
  });
});

describe('cagnotte and memberships at the back office (R-CAG-01, R-CAG-08, R-ADH-02)', () => {
  it('tops up, corrects and sells a membership', async () => {
    const { householdId } = (await post('/api/v1/members', newMember)).json();
    expect(
      (
        await post(`/api/v1/households/${householdId}/wallet/topup`, {
          amount: '30,5',
          method: 'CHEQUE',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post(`/api/v1/households/${householdId}/wallet/correction`, {
          amount: '-0.50',
          comment: 'erreur de saisie',
        })
      ).statusCode,
    ).toBe(200);
    const [bal] = await t.db
      .select()
      .from(householdBalance)
      .where(eq(householdBalance.householdId, householdId));
    expect(bal!.balance).toBe('30.00');

    const types = (await get('/api/v1/membership-types')).json();
    const annual = types.find((x: { code: string }) => x.code === 'ANNUAL');
    const ms = await post(`/api/v1/households/${householdId}/memberships`, {
      typeId: annual.id,
      method: 'CASH',
      date: '2026-10-15',
    });
    expect(ms.json()).toMatchObject({
      startDate: '2026-10-15',
      endDate: '2027-10-14',
      amount: '12.00',
    });
    expect(await t.db.select().from(membership)).toHaveLength(1);

    const detail = (await get(`/api/v1/households/${householdId}`)).json();
    expect(detail.wallet.map((w: { kind: string }) => w.kind)).toEqual(['CORRECTION', 'TOPUP']);
    expect(detail.payments).toHaveLength(2);
  });
});

describe('membership types (R-ADH-01, R-ADH-05)', () => {
  it('an ADMIN changes the price, and the till product follows', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const ah = await login(t.app, admin.username!);
    const annual = (await get('/api/v1/membership-types'))
      .json()
      .find((x: { code: string }) => x.code === 'ANNUAL');
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: `/api/v1/membership-types/${annual.id}`,
          headers,
          payload: { label: 'Annuelle', price: '15', durationMonths: 12, active: true },
        })
      ).statusCode,
    ).toBe(403);
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/membership-types/${annual.id}`,
      headers: ah,
      payload: { label: 'Annuelle', price: '15', durationMonths: 12, active: true },
    });
    expect(res.json()).toMatchObject({ price: '15.00' });
    const [p] = await t.db.select().from(product).where(eq(product.id, annual.productId));
    expect(p!.salePrice).toBe('15.00');
  });
});

describe('catalogue (R-PRD-01, R-PRD-05, R-PRD-06)', () => {
  async function shelf() {
    const [u] = await t.db
      .insert(universe)
      .values({ code: '1', name: 'Épicerie salée' })
      .returning();
    const [c] = await t.db
      .insert(category)
      .values({ universeId: u!.id, code: '11', name: 'Apéritif' })
      .returning();
    return c!;
  }
  const form = (categoryId: string) => ({
    name: 'Chips',
    description: '',
    kind: 'GOODS',
    saleMode: 'UNIT',
    unitQty: '0.155',
    unit: 'KG',
    saleCondition: 'ON_SITE',
    categoryId,
    supplierId: null,
    supplierRef: '',
    qualities: ['STANDARD'],
    vatRate: '5.50',
    status: 'ACTIVE',
    purchasePriceExcl: '1.20',
    salePrice: '2.50',
    minStock: null,
    eans: ['3168930167983'],
    posTabId: null,
    posLabel: '',
    posSort: 0,
  });

  it('proposes the next code of the shelf and records the price history', async () => {
    const c = await shelf();
    const a = (await post('/api/v1/products', form(c.id))).json();
    const b = (await post('/api/v1/products', { ...form(c.id), eans: [] })).json();
    expect([a.code, b.code]).toEqual(['111001', '111002']);
    const [p] = await t.db.select().from(product).where(eq(product.id, a.id));
    expect(p).toMatchObject({ purchasePriceIncl: '1.2660', labelPending: true });

    const loaded = (await get(`/api/v1/products/${a.id}`)).json();
    await patch(`/api/v1/products/${a.id}`, { salePrice: '2.60', updatedAt: loaded.updatedAt });
    const history = await t.db.select().from(priceHistory).where(eq(priceHistory.productId, a.id));
    expect(history.map((h) => h.salePrice).sort()).toEqual(['2.50', '2.60']);
  });

  it('refuses a barcode already used by another product', async () => {
    const c = await shelf();
    await post('/api/v1/products', form(c.id));
    expect((await post('/api/v1/products', form(c.id))).statusCode).toBe(409);
  });

  it('finds products by EAN, code or words of the name', async () => {
    const c = await shelf();
    const { id } = (await post('/api/v1/products', form(c.id))).json();
    for (const q of ['3168930167983', '111001', 'chips']) {
      expect(
        (await get(`/api/v1/products?q=${q}`)).json().map((p: { id: string }) => p.id),
        q,
      ).toEqual([id]);
    }
    expect((await get('/api/v1/products?q=1110')).json()).toHaveLength(0);
  });

  it('stores and serves a product image', async () => {
    const c = await shelf();
    const { id } = (await post('/api/v1/products', form(c.id))).json();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/products/${id}/image`,
      headers: { ...headers, 'content-type': 'image/png' },
      payload: png,
    });
    expect(up.statusCode).toBe(200);
    const img = await get(`/api/v1/media/${up.json().imageId}`);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(png)).toBe(true);
  });
});

describe('R-EVO-44 / R-EVO-40 consents on the member sheet', () => {
  const post = (payload: object) =>
    t.app.inject({ method: 'POST', url: '/api/v1/members', headers, payload });
  const read = async (id: string) =>
    (await t.app.inject({ url: `/api/v1/members/${id}`, headers })).json();

  it('dates the image consent when given, clears it when withdrawn, and keeps the ticket opt-out', async () => {
    const created = await post({ ...newMember, imageConsent: true, ticketEmailOptOut: true });
    expect(created.statusCode, created.body).toBe(200);
    const { id } = created.json() as { id: string };
    const m = await read(id);
    expect(m).toMatchObject({ imageConsent: true, ticketEmailOptOut: true });
    expect(m.imageConsentAt).toBeTruthy();

    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${id}`,
      headers,
      payload: { updatedAt: m.updatedAt, imageConsent: false, ticketEmailOptOut: false },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(await read(id)).toMatchObject({
      imageConsent: false,
      imageConsentAt: null,
      ticketEmailOptOut: false,
    });
  });

  it('is not consenting by default, and says so in the Excel export', async () => {
    const a = (await post({ ...newMember, email: 'a@example.org' })).json() as { id: string };
    await post({
      ...newMember,
      lastName: 'Martin',
      email: 'b@example.org',
      imageConsent: true,
    });
    expect(await read(a.id)).toMatchObject({ imageConsent: false, ticketEmailOptOut: false });

    const res = await t.app.inject({ url: '/api/v1/members.xlsx', headers });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Adhérents')!;
    const header = (ws.getRow(1).values as string[]).slice(1);
    const col = header.indexOf('Droit à l’image') + 1;
    const nameCol = header.indexOf('Nom') + 1;
    const byName = Object.fromEntries(
      Array.from({ length: ws.rowCount - 1 }, (_, i) => ws.getRow(i + 2)).map((r) => [
        String(r.getCell(nameCol).value),
        String(r.getCell(col).value),
      ]),
    );
    expect(byName.Dupont).toBe('Non renseigné');
    expect(byName.Martin).toMatch(/^Oui \(\d{4}-\d{2}-\d{2}\)$/);
  });
});
