import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, pdfTemplate, product } from '@episoft/db';
import { PDF_TEMPLATES, defaultPdfConfig, pdfTemplateDef } from '@episoft/shared';
import { sanitizePdfHtml, parsePdfHtml } from '../src/lib/pdf-html';
import { loadPdfConfig } from '../src/lib/pdf-template';
import { createUser, login, setupTestApp, waitForIdle } from './helpers';

// The PDF documents whose wording and columns the administrators edit: who may, what is cleaned and
// refused, the preview, and what a saved template changes in the document.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
let admin: Headers;
let other: Headers;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
afterEach(() => waitForIdle(t.db));
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`truncate app.pdf_template`);
  admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
  other = await login(
    t.app,
    (await createUser(t.db, { roles: ['ADHERENTS', 'COMPTA'] })).username!,
  );
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Headers,
  payload?: object,
) => t.app.inject({ method, url: `/api/v1${url}`, headers, payload });

const def = pdfTemplateDef('purchase_order')!;
const save = (key: string, config: object, headers = admin) =>
  call('PUT', `/pdf-templates/${key}`, headers, config);
const orderConfig = (over: object = {}) => ({ ...defaultPdfConfig(def), ...over });

describe('who may edit the PDF documents', () => {
  it('is reserved to the administrators, on every route', async () => {
    const routes: [Parameters<typeof call>[0], string][] = [
      ['GET', '/pdf-templates'],
      ['GET', '/pdf-templates/purchase_order'],
      ['PUT', '/pdf-templates/purchase_order'],
      ['DELETE', '/pdf-templates/purchase_order'],
      ['POST', '/pdf-templates/purchase_order/preview'],
    ];
    for (const [method, url] of routes)
      expect((await call(method, url, other, {})).statusCode, `${method} ${url}`).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/pdf-templates' })).statusCode).toBe(
      401,
    );
  });
});

describe('the list and the detail', () => {
  it('lists every document of the application, none edited yet', async () => {
    const list = (await call('GET', '/pdf-templates', admin)).json();
    expect(list.map((d: { key: string }) => d.key)).toEqual(PDF_TEMPLATES.map((d) => d.key));
    expect(list.every((d: { customized: boolean }) => !d.customized)).toBe(true);
  });

  it('gives the template, the original, the variables, the zones and the columns of one document', async () => {
    const d = (await call('GET', '/pdf-templates/purchase_order', admin)).json();
    expect(d.customized).toBe(false);
    expect(d.config).toEqual(defaultPdfConfig(def));
    expect(d.defaults).toEqual(d.config);
    expect(d.columns.map((c: { key: string }) => c.key)).toContain('unit_excl');
    expect(d.zones.map((z: { key: string }) => z.key)).toEqual([
      'header',
      'supplier',
      'after_table',
      'footer',
    ]);
    expect(d.variables.map((v: { name: string }) => v.name)).toContain('fournisseur_nom');
    expect((await call('GET', '/pdf-templates/inconnu', admin)).statusCode).toBe(400);
  });
});

describe('what is kept of a zone', () => {
  const clean = sanitizePdfHtml;

  it('keeps the formatting a PDF can draw', () => {
    const html =
      '<h2>Titre</h2><p style="text-align:center">Un <strong>mot</strong> <em>pené</em> <u>souligné</u></p><ul><li>un</li></ul>';
    expect(clean(html)).toBe(html);
    expect(clean('<p><span style="color:#14532d">vert</span></p>')).toBe(
      '<p><span style="color:#14532d">vert</span></p>',
    );
  });

  it('removes scripts, links, images, handlers and styles that are not about the look of the text', () => {
    expect(clean('<p onclick="x()">a<script>alert(1)</script></p>')).toBe('<p>a</p>');
    expect(clean('<p><a href="javascript:x()">lien</a></p>')).toBe('<p>lien</p>');
    expect(clean('<p><img src="https://x.test/a.png">b</p>')).toBe('<p>b</p>');
    expect(clean('<p style="position:absolute;color:red">c</p>')).toBe(
      '<p style="color:red">c</p>',
    );
    expect(clean('<table><tr><td>d</td></tr></table>')).toBe('d');
  });

  it('is read as blocks: paragraphs, lines, lists, styles', () => {
    const blocks = parsePdfHtml(
      '<p>Une<br>deux <strong>gras</strong></p><ol><li>a</li><li>b</li></ol><h3>T</h3>',
    );
    expect(blocks.map((b) => [b.kind, b.bullet, b.runs.map((r) => r.text).join('')])).toEqual([
      ['p', null, 'Une\ndeux gras'],
      ['li', '1.', 'a'],
      ['li', '2.', 'b'],
      ['h3', null, 'T'],
    ]);
    expect(blocks[0]!.runs.at(-1)).toMatchObject({ text: 'gras', bold: true });
  });
});

describe('editing a document', () => {
  it('saves the template, says it is edited, and putting the original back deletes it', async () => {
    const res = await save(
      'purchase_order',
      orderConfig({
        zones: { ...defaultPdfConfig(def).zones, footer: '<p>Association loi 1901</p>' },
        columns: [
          { key: 'ref', label: 'Réf.' },
          { key: 'name', label: 'Produit' },
          { key: 'qty', label: 'Qté' },
          { key: 'total_excl', label: 'Total HT' },
        ],
        labels: { total: 'À régler' },
        logo: false,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ customized: true });
    expect(res.json().config.columns.map((c: { key: string }) => c.key)).toEqual([
      'ref',
      'name',
      'qty',
      'total_excl',
    ]);
    const loaded = await loadPdfConfig(t.db, 'purchase_order');
    expect(loaded.customized).toBe(true);
    expect(loaded.config.labels.total).toBe('À régler');
    expect(loaded.config.logo).toBe(false);
    expect(loaded.config.zones.footer).toBe('<p>Association loi 1901</p>');

    expect((await call('DELETE', '/pdf-templates/purchase_order', admin)).statusCode).toBe(204);
    expect(await t.db.select().from(pdfTemplate)).toHaveLength(0);
    expect((await loadPdfConfig(t.db, 'purchase_order')).config).toEqual(defaultPdfConfig(def));
    // Putting the original back twice is not an error.
    expect((await call('DELETE', '/pdf-templates/purchase_order', admin)).statusCode).toBe(204);
  });

  it('cleans the zones when saved, whatever the request carries', async () => {
    await save(
      'purchase_order',
      orderConfig({
        zones: {
          ...defaultPdfConfig(def).zones,
          header: '<p onclick="x()">{{numero}}</p><script>alert(1)</script><img src="x">',
        },
      }),
    );
    const [row] = await t.db.select().from(pdfTemplate);
    expect((row!.config as { zones: { header: string } }).zones.header).toBe('<p>{{numero}}</p>');
  });

  it('refuses an unknown variable, a column that does not exist, a table without its product', async () => {
    const unknown = await save(
      'purchase_order',
      orderConfig({ zones: { ...defaultPdfConfig(def).zones, header: '<p>{{nimporte}}</p>' } }),
    );
    expect(unknown.statusCode).toBe(400);
    expect(JSON.stringify(unknown.json())).toContain('{{nimporte}}');
    expect(
      (await save('purchase_order', orderConfig({ columns: [{ key: 'qty', label: 'Q' }] })))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await save(
          'purchase_order',
          orderConfig({
            columns: [
              { key: 'name', label: 'P' },
              { key: 'nimporte', label: 'X' },
            ],
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect((await save('purchase_order', orderConfig({ columns: [] }))).statusCode).toBe(400);
    expect(await t.db.select().from(pdfTemplate)).toHaveLength(0);
  });

  it('refuses a logo for a document that has none, and columns for one that has no choice', async () => {
    const closing = defaultPdfConfig(pdfTemplateDef('cash_closing')!);
    expect((await save('cash_closing', { ...closing, logo: true })).statusCode).toBe(400);
    expect(
      (await save('cash_closing', { ...closing, columns: [{ key: 'name', label: 'P' }] }))
        .statusCode,
    ).toBe(400);
    expect((await save('cash_closing', closing)).statusCode).toBe(200);
  });

  it('records the change and the return to the original in the journal', async () => {
    await save('purchase_order', orderConfig());
    await call('DELETE', '/pdf-templates/purchase_order', admin);
    await waitForIdle(t.db);
    const actions = (await t.db.select().from(auditLog).where(eq(auditLog.entity, 'pdf_template')))
      .map((a) => a.action)
      .sort();
    expect(actions).toEqual(['pdf_template.reset', 'pdf_template.update']);
  });
});

describe('the preview', () => {
  it.each(PDF_TEMPLATES.map((d) => d.key))('makes a PDF of %s with the draft', async (key) => {
    const d = pdfTemplateDef(key)!;
    const res = await call('POST', `/pdf-templates/${key}/preview`, admin, {
      config: defaultPdfConfig(d),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('shows the draft of the editor, and the saved template when there is no draft', async () => {
    const plain = await call('POST', '/pdf-templates/purchase_order/preview', admin, {});
    const allColumns = orderConfig({
      columns: def.columns.map((c) => ({ key: c.key, label: c.label })),
    });
    const draft = await call('POST', '/pdf-templates/purchase_order/preview', admin, {
      config: allColumns,
    });
    expect(draft.rawPayload.length).not.toBe(plain.rawPayload.length);
    await save('purchase_order', allColumns);
    const saved = await call('POST', '/pdf-templates/purchase_order/preview', admin, {});
    expect(saved.rawPayload.length).toBe(draft.rawPayload.length);
  });

  it('refuses a draft with a mistake, in words, and saves nothing', async () => {
    const res = await call('POST', '/pdf-templates/purchase_order/preview', admin, {
      config: orderConfig({ columns: [{ key: 'qty', label: 'Q' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('indispensable');
    expect(await t.db.select().from(pdfTemplate)).toHaveLength(0);
  });
});

describe('what a saved template changes in the documents', () => {
  it('the purchase order PDF follows the columns, the zones and the logo of the template', async () => {
    const buyer = await login(
      t.app,
      (await createUser(t.db, { roles: ['ADMIN', 'APPROS', 'PRODUITS'] })).username!,
    );
    const supplier = (
      await call('POST', '/suppliers', buyer, {
        region: '07',
        name: 'Ferme du Moulin',
        contact: '',
        street: '1 rue du Moulin',
        postcode: '60240',
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
      })
    ).json();
    expect(supplier.id, JSON.stringify(supplier)).toBeTruthy();
    const [honey] = await t.db
      .insert(product)
      .values({
        code: '211001',
        name: 'Miel',
        supplierId: supplier.id,
        salePrice: '8.00',
        purchasePriceExcl: '5.0000',
        vatRate: '5.50',
        stockQty: '0',
        minStock: '6',
      })
      .returning();
    const order = (
      await call('POST', '/purchase-orders', buyer, { supplierId: supplier.id })
    ).json();
    await call('PUT', `/purchase-orders/${order.id}`, buyer, {
      lines: [{ productId: honey!.id, qty: '10', unitPriceExcl: '5' }],
    });
    const download = () => call('GET', `/purchase-orders/${order.id}/pdf`, buyer);

    const before = await download();
    expect(before.statusCode).toBe(200);
    expect(before.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    await save(
      'purchase_order',
      orderConfig({
        columns: def.columns.map((c) => ({ key: c.key, label: c.label })),
        zones: {
          ...defaultPdfConfig(def).zones,
          footer: '<p>Association loi 1901</p>',
        },
      }),
      buyer,
    );
    const after = await download();
    expect(after.statusCode).toBe(200);
    expect(after.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(after.rawPayload.equals(before.rawPayload)).toBe(false);

    // A template that cannot be read leaves the order printable, in the wording of the application.
    await t.db.execute(sql`update app.pdf_template set config = '{"zones": 3}'::jsonb`);
    expect((await download()).statusCode).toBe(200);
  });
});
