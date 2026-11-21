import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { member, product, supplier } from '@episoft/db';
import { PROCESSING_REGISTER } from '@episoft/shared';
import { createUser, login, refusedToAppRole, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// Product information (INCO 1169/2011), « bio » (2018/848), « local », traceability (178/2002),
// RGPD consents and legal pages.

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

const today = () => new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const productBody = (over: Record<string, unknown> = {}) => ({
  name: 'Farine T65',
  description: null,
  kind: 'GOODS',
  saleMode: 'UNIT',
  unitQty: '1',
  unit: 'KG',
  saleCondition: 'ON_SITE',
  categoryId: null,
  supplierId: null,
  supplierRef: null,
  qualities: [],
  vatRate: '5.50',
  status: 'ACTIVE',
  purchasePriceExcl: null,
  salePrice: '2.50',
  minStock: null,
  eans: [],
  posTabId: null,
  posLabel: null,
  posSort: 0,
  code: String(700000 + Math.floor(Math.random() * 99999)),
  ...over,
});

describe('product information and claims', () => {
  let h: Record<string, string>;
  beforeEach(async () => {
    await t.reset();
    await t.db.execute(sql`delete from app.supplier`);
    h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
  });
  const post = (payload: object) =>
    t.app.inject({ method: 'POST', url: '/api/v1/products', headers: h, payload });

  it('refuses a food product without an allergen decision, accepts the explicit « aucun »', async () => {
    const res = await post(productBody({ isFood: true, ingredients: 'Blé' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Allergènes/);
    const ok = await post(
      productBody({ isFood: true, ingredients: 'Blé', allergensDecision: 'NONE' }),
    );
    expect(ok.statusCode).toBe(200);
  });

  it('refuses a food product without ingredients, or honey without origin', async () => {
    expect((await post(productBody({ isFood: true, allergensDecision: 'NONE' }))).statusCode).toBe(
      400,
    );
    const honey = productBody({
      isFood: true,
      ingredients: 'Miel',
      allergensDecision: 'NONE',
      originFamily: 'HONEY',
    });
    const res = await post(honey);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Origine obligatoire/);
    expect((await post({ ...honey, origin: 'France, Oise' })).statusCode).toBe(200);
  });

  it('refuses « local » without justification', async () => {
    expect((await post(productBody({ qualities: ['LOCAL'] }))).statusCode).toBe(400);
    expect(
      (await post(productBody({ qualities: ['LOCAL'], localJustification: 'Ferme Durand, 5 km' })))
        .statusCode,
    ).toBe(200);
  });

  it('refuses « bio » unless the supplier holds a valid certificate', async () => {
    const [s] = await t.db
      .insert(supplier)
      .values({ code: '60001', name: 'Ferme Bio' })
      .returning();
    const bio = productBody({ qualities: ['ORGANIC'], supplierId: s!.id });
    expect((await post(productBody({ qualities: ['ORGANIC'] }))).statusCode).toBe(400);
    const missing = await post(bio);
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toMatch(/pas de certificat bio complet/);

    await t.db.update(supplier).set({
      organicCertNumber: 'FR-BIO-01-1',
      organicCertBody: 'Ecocert',
      organicCertExpiry: day(-1),
    });
    const expired = await post(bio);
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toMatch(/a expiré le/);

    await t.db.update(supplier).set({ organicCertExpiry: day(200) });
    expect((await post(bio)).statusCode).toBe(200);
  });

  it('refuses a patch that adds « bio » to a product whose supplier has no certificate', async () => {
    const [s] = await t.db.insert(supplier).values({ code: '60002', name: 'Ferme' }).returning();
    const created = (await post(productBody({ supplierId: s!.id }))).json() as { id: string };
    const detail = (
      await t.app.inject({ method: 'GET', url: `/api/v1/products/${created.id}`, headers: h })
    ).json() as { updatedAt: string };
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${created.id}`,
      headers: h,
      payload: { qualities: ['ORGANIC'], updatedAt: detail.updatedAt },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an incomplete organic certificate on a supplier', async () => {
    const ap = await login(t.app, (await createUser(t.db, { roles: ['APPROS'] })).username!);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: ap,
      payload: {
        region: '60',
        name: 'Ferme X',
        contact: null,
        street: null,
        postcode: null,
        communeId: null,
        phone: null,
        email: null,
        website: null,
        priceListUrl: null,
        active: true,
        publicNotes: null,
        privateNotes: null,
        referentMemberId: null,
        sendsPo: false,
        accountNumber: null,
        minOrderAmount: null,
        paymentTermsDays: 30,
        deliveryDay: null,
        organicCertNumber: 'FR-BIO-01-9',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Certificat bio incomplet/);
  });

  it('prints no label for a food product with missing information, and raises an alert', async () => {
    const [p] = await t.db
      .insert(product)
      .values({ code: '700900', name: 'Pâtes', salePrice: '2.00', isFood: true })
      .returning();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/products/labels/pdf',
      headers: h,
      payload: { productIds: [p!.id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Étiquettes non imprimées/);
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const items = (
      await t.app.inject({ method: 'GET', url: '/api/v1/admin/attention', headers: admin })
    ).json() as { code: string; count: number }[];
    expect(items.find((i) => i.code === 'FOOD_INFO_MISSING')?.count).toBe(1);
    expect(items.some((i) => i.code === 'LEGAL_PAGES_INCOMPLETE')).toBe(true);
  });

  it('prints a label with the allergens of a complete product', async () => {
    const [p] = await t.db
      .insert(product)
      .values({
        code: '700901',
        name: 'Pâtes',
        salePrice: '2.00',
        isFood: true,
        unitQty: '500',
        unit: 'G',
        ingredients: 'Blé dur',
        allergensDecision: 'LISTED',
        allergens: ['GLUTEN'],
      })
      .returning();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/products/labels/pdf',
      headers: h,
      payload: { productIds: [p!.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });
});

describe('lot traceability (178/2002)', () => {
  let till: Till;
  beforeEach(async () => {
    till = await openTill(t);
  });

  it('asks the lot and the date at receipt for a food product, then traces a lot to its customers', async () => {
    const ap = await login(t.app, (await createUser(t.db, { roles: ['APPROS'] })).username!);
    const [s] = await t.db.insert(supplier).values({ code: '60010', name: 'Laiterie' }).returning();
    const p = await addProduct(t.db, {
      name: 'Yaourt',
      stockQty: '0',
      isFood: true,
      ingredients: 'Lait',
      allergensDecision: 'LISTED',
      allergens: ['MILK'],
    });
    const receive = (lotNumber: string | null, bestBefore: string | null, qty = '5') =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/receipts',
        headers: ap,
        payload: {
          supplierId: s!.id,
          lines: [
            {
              orderLineId: null,
              productId: p.id,
              qty,
              unitPriceExcl: '0.50',
              bestBefore,
              lotNumber,
            },
          ],
        },
      });
    const noLot = await receive(null, day(10));
    expect(noLot.statusCode).toBe(400);
    expect(noLot.body).toMatch(/lot/);
    expect((await receive('L-A', null)).statusCode).toBe(400);
    expect((await receive('0', day(10))).statusCode).toBe(400);

    // Two lots: B expires first and must be consumed first (FEFO), whatever the order of arrival.
    expect((await receive('L-A', day(30))).statusCode).toBe(200);
    expect((await receive('L-B', day(5))).statusCode).toBe(200);

    const buyer = await createUser(t.db, { roles: [], email: 'client@example.org' });
    const op = till.saleOp([{ productId: p.id, qty: '3', unitPrice: '1.00' }], '3.00');
    (op.payload as { memberId: string | null }).memberId = buyer.id;
    expect((await till.push([op]))[0]!.status).toBe('OK');
    await t.db.update(member).set({ status: 'ACTIVE' });

    const lots = (
      await t.app.inject({ method: 'GET', url: '/api/v1/traceability/lots', headers: ap })
    ).json() as { id: string; lotNumber: string }[];
    expect(lots.map((l) => l.lotNumber).sort()).toEqual(['L-A', 'L-B']);
    const lotB = lots.find((l) => l.lotNumber === 'L-B')!;
    const lotA = lots.find((l) => l.lotNumber === 'L-A')!;

    const report = (
      await t.app.inject({
        method: 'GET',
        url: `/api/v1/traceability/lots/${lotB.id}`,
        headers: ap,
      })
    ).json() as {
      soldQty: string;
      remainingQty: string;
      tickets: { member: { id: string } | null }[];
      method: string;
    };
    expect(report.method).toBe('FEFO');
    expect(report.soldQty).toBe('3.000');
    expect(report.remainingQty).toBe('2.000');
    expect(report.tickets[0]!.member!.id).toBe(buyer.id);
    const reportA = (
      await t.app.inject({
        method: 'GET',
        url: `/api/v1/traceability/lots/${lotA.id}`,
        headers: ap,
      })
    ).json() as { tickets: unknown[] };
    expect(reportA.tickets).toHaveLength(0);

    const recall = (
      await t.app.inject({
        method: 'GET',
        url: `/api/v1/traceability/lots/${lotB.id}/recall`,
        headers: ap,
      })
    ).json() as { emails: string[]; members: { id: string }[] };
    expect(recall.emails).toEqual(['client@example.org']);
    expect(recall.members).toHaveLength(1);
    const logged = await t.db.execute(
      sql`select count(*)::int as n from app.audit_log where action = 'lot.recall_view'`,
    );
    expect((logged.rows[0] as { n: number }).n).toBe(1);

    // From the sale: the lot(s) it comes from.
    const sales = await t.db.execute(sql`select number from app.sale limit 1`);
    const number = (sales.rows[0] as { number: string }).number;
    const fromSale = (
      await t.app.inject({
        method: 'GET',
        url: `/api/v1/traceability/sales/${encodeURIComponent(number)}`,
        headers: ap,
      })
    ).json() as { lines: { lots: { lotNumber: string }[] }[] };
    expect(fromSale.lines[0]!.lots.map((l) => l.lotNumber)).toEqual(['L-B']);

    // Not for everyone.
    const nobody = await login(t.app, (await createUser(t.db, { roles: ['CAISSE'] })).username!);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/traceability/lots/${lotB.id}/recall`,
          headers: nobody,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('does not ask a lot for a product that is not food', async () => {
    const ap = await login(t.app, (await createUser(t.db, { roles: ['APPROS'] })).username!);
    const [s] = await t.db.insert(supplier).values({ code: '60011', name: 'Savon' }).returning();
    const p = await addProduct(t.db, { name: 'Savon', stockQty: '0' });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/receipts',
      headers: ap,
      payload: {
        supplierId: s!.id,
        lines: [{ orderLineId: null, productId: p.id, qty: '2', unitPriceExcl: '1.00' }],
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('RGPD: consents and legal pages', () => {
  beforeEach(() => t.reset());

  const memberBody = (over: Record<string, unknown> = {}) => ({
    lastName: 'Martin',
    firstName: 'Léa',
    street: null,
    postcode: null,
    communeId: null,
    phone: null,
    email: 'lea@example.org',
    status: 'ACTIVE',
    publicVisible: false,
    newsletter: true,
    ticketEmailOptOut: false,
    imageConsent: false,
    username: null,
    householdId: null,
    ...over,
  });

  it('refuses a member card without the privacy notice, records the consents with their history', async () => {
    const staff = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const refused = await t.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: staff,
      payload: memberBody(),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/politique de confidentialité/);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: staff,
      payload: memberBody({ privacyNoticeGiven: true }),
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json() as { id: string };
    const sheet = (
      await t.app.inject({ method: 'GET', url: `/api/v1/members/${id}/consents`, headers: staff })
    ).json() as {
      items: { purpose: string; granted: boolean; recorded: boolean }[];
      history: { purpose: string; granted: boolean; channel: string; textVersion: string }[];
    };
    const by = Object.fromEntries(sheet.items.map((i) => [i.purpose, i]));
    expect(by.DATA_PROCESSING).toMatchObject({ granted: true, recorded: true });
    expect(by.NEWSLETTER).toMatchObject({ granted: true, recorded: true });
    expect(by.IMAGE_RIGHTS).toMatchObject({ granted: false, recorded: false });
    expect(sheet.history.every((h) => h.channel === 'STAFF_FORM' && h.textVersion)).toBe(true);

    // The staff changes a flag: a new row, the old one stays.
    const detail = (
      await t.app.inject({ method: 'GET', url: `/api/v1/members/${id}`, headers: staff })
    ).json() as { updatedAt: string };
    await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${id}`,
      headers: staff,
      payload: { newsletter: false, updatedAt: detail.updatedAt },
    });
    const after = (
      await t.app.inject({ method: 'GET', url: `/api/v1/members/${id}/consents`, headers: staff })
    ).json() as { items: { purpose: string; granted: boolean }[]; history: { purpose: string }[] };
    expect(after.items.find((i) => i.purpose === 'NEWSLETTER')!.granted).toBe(false);
    expect(after.history.filter((h) => h.purpose === 'NEWSLETTER')).toHaveLength(2);
  });

  it('lets a member withdraw a consent, but not the information record', async () => {
    const m = await createUser(t.db, { roles: [] });
    await t.db
      .update(member)
      .set({ imageConsentAt: new Date() })
      .where(sql`id = ${m.id}`);
    const h = await login(t.app, m.username!);
    const put = (payload: object) =>
      t.app.inject({ method: 'PUT', url: '/api/v1/me/consents', headers: h, payload });
    const out = await put({ purpose: 'IMAGE_RIGHTS', granted: false });
    expect(out.statusCode).toBe(200);
    const row = await t.db.execute(sql`select image_consent_at from app.member where id = ${m.id}`);
    expect((row.rows[0] as { image_consent_at: unknown }).image_consent_at).toBeNull();
    const none = await t.db.execute(
      sql`select count(*)::int as n from app.consent where member_id = ${m.id}`,
    );
    // The grant the sheet already held, recorded first, then the withdrawal.
    expect((none.rows[0] as { n: number }).n).toBe(2);
    expect((await put({ purpose: 'DATA_PROCESSING', granted: false })).statusCode).toBe(400);
    expect((await put({ purpose: 'NOTIFICATIONS', granted: true })).statusCode).toBe(400);
    const exp = (
      await t.app.inject({ method: 'GET', url: '/api/v1/me/export', headers: h })
    ).json() as { consents: unknown[] };
    expect(exp.consents).toHaveLength(2);
  });

  it('keeps consents as evidence: the application role cannot rewrite one', async () => {
    const m = await createUser(t.db, { roles: [] });
    await t.db.execute(
      sql`insert into app.consent (id, member_id, purpose, granted, text_version, channel)
          values (gen_random_uuid(), ${m.id}, 'NEWSLETTER', true, '2026-11', 'STAFF_FORM')`,
    );
    expect(
      await refusedToAppRole(sql`update app.consent set granted = false where member_id = ${m.id}`),
    ).toBe('23000');
  });

  it('serves the legal pages without a session and tells an administrator what is missing', async () => {
    const pub = await t.app.inject({ method: 'GET', url: '/api/v1/legal' });
    expect(pub.statusCode).toBe(200);
    const body = pub.json() as { mentions: { title: string }[]; privacy: { title: string }[] };
    expect(body.privacy.map((s) => s.title)).toContain('Vos droits');
    expect(body.mentions.map((s) => s.title)).toContain('Hébergement');
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const gaps = (
      await t.app.inject({ method: 'GET', url: '/api/v1/admin/legal/gaps', headers: admin })
    ).json() as string[];
    expect(gaps.length).toBeGreaterThan(0);
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/legal.texts',
      headers: admin,
      payload: {
        publicationDirector: 'A. Durand',
        hostName: 'Hébergeur',
        hostAddress: 'Paris',
        privacyContact: 'dpo@example.org',
        dpoName: null,
        dpoContact: null,
        purposes: null,
        legalBasis: null,
        retention: 'Cinq ans.',
        recipients: null,
        rights: null,
        extra: null,
      },
    });
    expect(put.statusCode).toBe(200);
    const again = (await t.app.inject({ method: 'GET', url: '/api/v1/legal' })).json() as {
      privacy: { title: string; paragraphs: string[] }[];
    };
    expect(again.privacy.find((s) => s.title.startsWith('Combien'))!.paragraphs).toEqual([
      'Cinq ans.',
    ]);
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/legal.texts',
      headers: admin,
      payload: { ...(put.json() as object), privacyContact: 'pas un courriel' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('the register of processing covers every table that points to a member', async () => {
    const rows = await t.db.execute(sql`
      select distinct c.relname as t from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where k.contype = 'f' and k.confrelid = 'app.member'::regclass and n.nspname = 'app'`);
    const covered = new Set(PROCESSING_REGISTER.flatMap((a) => a.tables));
    // Tables that point to a member for another reason than personal data of the member.
    const technical = new Set([
      'member',
      'supplier',
      'household',
      'product_batch',
      'product_lot',
      'goods_receipt',
      'purchase_order',
      'supplier_invoice',
      'supplier_credit_note',
      'supplier_credit_allocation',
      'vat_regime_change',
      'price_history',
      'stock_movement',
      'inventory_session',
      'inventory_line',
      'cash_count',
      'cash_deposit',
      'cash_session',
      'pos_device',
      'entry',
      'entry_line',
      'bank_statement',
      'bank_line',
      'bank_rule',
      'fiscal_year',
      'saved_report',
      'import_log',
      'integrity_ack',
      'sync_rejection',
      'email_template',
      'email_layout',
      'email_asset',
      'pdf_template',
      'setting',
      'job_run',
      'error_log',
      'budget_line',
      'membership_reminder',
      'entry_template',
      'membership_type',
      'reconciliation',
    ]);
    const missing = (rows.rows as { t: string }[])
      .map((r) => r.t)
      .filter((name) => !covered.has(name) && !technical.has(name));
    expect(missing).toEqual([]);
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/processing-register',
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(PROCESSING_REGISTER.length);
    void today;
  });
});
