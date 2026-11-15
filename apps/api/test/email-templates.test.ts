import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailAsset, emailOutbox, emailTemplate, member } from '@episoft/db';
import { EMAIL_TEMPLATES, EMAIL_TEMPLATE_KEYS, sampleValues } from '@episoft/shared';
import { notifyStaff } from '../src/lib/alerts';
import { queueTemplatedEmail, renderEmail } from '../src/lib/email-render';
import { withoutInlineImages } from '../src/lib/mail';
import { sanitizeEmailHtml } from '../src/lib/email-sanitize';
import { createUser, login, setupTestApp, waitForIdle } from './helpers';

// E-mails whose wording the administrators edit: variables, the layout common to all, the images
// inside the messages, and what is refused (scripts, remote images, unknown variables).

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
let admin: Headers;
let adminEmail: string;
let other: Headers;

// A 1×1 PNG, and bytes that only claim to be one.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
afterEach(() => waitForIdle(t.db));
beforeEach(async () => {
  await t.reset();
  await t.db.execute(
    sql`truncate app.email_template, app.email_layout, app.email_asset, app.email_outbox cascade`,
  );
  const a = await createUser(t.db, { roles: ['ADMIN'] });
  adminEmail = a.email!;
  admin = await login(t.app, a.username!);
  other = await login(
    t.app,
    (await createUser(t.db, { roles: ['ADHERENTS', 'COMPTA'] })).username!,
  );
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Headers,
  payload?: object | Buffer,
  extra: Headers = {},
) => t.app.inject({ method, url: `/api/v1${url}`, headers: { ...headers, ...extra }, payload });

const upload = (headers: Headers, bytes: Buffer, type = 'image/png', name = 'logo.png') =>
  call('POST', '/email-assets', headers, bytes, {
    'content-type': type,
    'x-file-name': encodeURIComponent(name),
  });

const outbox = async () => t.db.select().from(emailOutbox);

describe('who may edit the e-mails', () => {
  it('is reserved to the administrators, on every route', async () => {
    const id = '0190a0a0-0000-7000-8000-000000000001';
    const routes: [Parameters<typeof call>[0], string][] = [
      ['GET', '/email-templates'],
      ['GET', '/email-templates/wallet_low'],
      ['PUT', '/email-templates/wallet_low'],
      ['DELETE', '/email-templates/wallet_low'],
      ['POST', '/email-templates/wallet_low/preview'],
      ['POST', '/email-templates/wallet_low/test'],
      ['GET', '/email-layout'],
      ['PUT', '/email-layout'],
      ['GET', '/email-assets'],
      ['GET', `/email-assets/${id}`],
      ['DELETE', `/email-assets/${id}`],
    ];
    for (const [method, url] of routes)
      expect((await call(method, url, other, {})).statusCode, `${method} ${url}`).toBe(403);
    expect((await upload(other, PNG)).statusCode).toBe(403);
  });
});

describe('the list and the detail', () => {
  it('lists every e-mail of the application, none edited yet', async () => {
    const rows = (await call('GET', '/email-templates', admin)).json();
    expect(rows.map((r: { key: string }) => r.key)).toEqual(EMAIL_TEMPLATES.map((x) => x.key));
    expect(rows.every((r: { customized: boolean }) => !r.customized)).toBe(true);
    expect(rows.some((r: { audience: string }) => r.audience === 'MEMBER')).toBe(true);
    expect(rows.some((r: { audience: string }) => r.audience === 'STAFF')).toBe(true);
  });

  it('gives the wording, the original and the variables of one e-mail', async () => {
    const d = (await call('GET', '/email-templates/password_link', admin)).json();
    expect(d).toMatchObject({ key: 'password_link', customized: false });
    expect(d.subject).toBe(d.defaultSubject);
    expect(d.variables.map((v: { name: string }) => v.name)).toEqual(['prenom', 'lien']);
    expect((await call('GET', '/email-templates/inconnu', admin)).statusCode).toBe(400);
  });
});

describe('editing the wording', () => {
  const save = (key: string, subject: string, body: string) =>
    call('PUT', `/email-templates/${key}`, admin, { subject, body });

  it('saves a new wording and says it is edited; deleting puts the original back', async () => {
    const res = await save(
      'wallet_low',
      'Votre cagnotte, {{prenom}}',
      '<p>Coucou {{prenom}} : {{message}}</p>',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      customized: true,
      subject: 'Votre cagnotte, {{prenom}}',
      body: '<p>Coucou {{prenom}} : {{message}}</p>',
    });
    expect((await call('DELETE', '/email-templates/wallet_low', admin)).statusCode).toBe(204);
    const back = (await call('GET', '/email-templates/wallet_low', admin)).json();
    expect(back.customized).toBe(false);
    expect(back.subject).toBe(back.defaultSubject);
    // Putting the original back twice is not an error.
    expect((await call('DELETE', '/email-templates/wallet_low', admin)).statusCode).toBe(204);
  });

  it('refuses an unknown variable, a variable that cannot be in a subject, and a missing link', async () => {
    const unknown = await save('wallet_low', 'x', '<p>{{message}} {{nimporte}}</p>');
    expect(unknown.statusCode).toBe(400);
    expect(JSON.stringify(unknown.json())).toContain('{{nimporte}}');
    expect((await save('sale_receipt', 'Ticket {{lignes}}', '<p>{{lignes}}</p>')).statusCode).toBe(
      400,
    );
    const noLink = await save('password_link', 'Mot de passe', '<p>Bonjour {{prenom}}</p>');
    expect(noLink.statusCode).toBe(400);
    expect(JSON.stringify(noLink.json())).toContain('{{lien}}');
    expect(await t.db.select().from(emailTemplate)).toHaveLength(0);
  });

  it('refuses a typed text in a link: a title cannot become the address', async () => {
    const r = await save(
      'feedback_reply',
      'x',
      '<p><a href="{{titre}}">{{message}}</a></p><p title="{{message}}">x</p>',
    );
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toContain('ne peut pas être dans un lien');
    expect(await t.db.select().from(emailTemplate)).toHaveLength(0);
    // The address of the application is what a link may hold.
    expect(
      (await save('password_link', 'x', '<p><a href="{{lien}}">{{prenom}}</a></p>')).statusCode,
    ).toBe(200);
  });

  it('refuses an empty subject or message', async () => {
    expect((await save('wallet_low', ' ', '<p>x</p>')).statusCode).toBe(400);
    expect((await save('wallet_low', 'x', ' ')).statusCode).toBe(400);
  });

  it('records the change and the return to the original in the journal', async () => {
    await save('wallet_low', 'Nouvel objet', '<p>{{message}}</p>');
    await call('DELETE', '/email-templates/wallet_low', admin);
    const { rows } = await t.db.execute<{ action: string }>(
      sql`select action from app.audit_log where entity = 'email_template' order by id`,
    );
    expect(rows.map((r) => r.action)).toEqual(['email_template.update', 'email_template.reset']);
  });
});

describe('what is kept of the HTML', () => {
  const clean = sanitizeEmailHtml;

  it('keeps the formatting an e-mail needs', () => {
    const html =
      '<h2>Titre</h2><p style="color:#14532d;text-align:center">Bonjour <strong>Marie</strong> <em>!</em></p>' +
      '<ul><li>un</li></ul><table><tr><td style="padding:4px">x</td></tr></table>' +
      '<a href="https://exemple.org/page" title="t">lien</a>';
    expect(clean(html)).toBe(html);
  });

  it('removes scripts, event handlers, frames, forms and styles that load something', () => {
    const out = clean(
      '<p onclick="evil()">a</p><script>alert(1)</script><iframe src="https://x.org"></iframe>' +
        '<form action="https://x.org"><input name="p"></form><style>p{}</style>' +
        '<p style="background:url(https://x.org/t.png);color:red">b</p><object data="x"></object>',
    );
    for (const bad of [
      'onclick',
      '<script',
      'alert(1)',
      '<iframe',
      '<form',
      '<input',
      '<style',
      'url(',
      '<object',
    ])
      expect(out).not.toContain(bad);
    expect(out).toContain('color:red');
  });

  it('removes links that run code or carry data, and keeps web, mail and phone links', () => {
    const out = clean(
      '<a href="javascript:alert(1)">a</a><a href="data:text/html;base64,AAAA">b</a>' +
        '<a href="vbscript:x">c</a><a href="mailto:a@b.org">d</a><a href="tel:+33123456789">e</a>' +
        '<a href="https://exemple.org">f</a>',
    );
    expect(out).not.toMatch(/javascript:|data:|vbscript:/i);
    expect(out).toContain('mailto:a@b.org');
    expect(out).toContain('tel:+33123456789');
    expect(out).toContain('https://exemple.org');
  });

  it('keeps only the images of the library: no remote image, no data image', () => {
    const id = '0190a0a0-0000-7000-8000-000000000001';
    const out = clean(
      `<img src="/api/v1/email-assets/${id}" alt="logo"><img src="https://tracker.example/p.gif">` +
        '<img src="data:image/svg+xml;base64,AAAA"><img src="/api/v1/media/abc">',
    );
    expect(out).toContain(`/api/v1/email-assets/${id}`);
    expect(out).not.toContain('tracker.example');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('/media/');
  });

  it('keeps a {{lien}} in an address, however the editor wrote it', () => {
    expect(clean('<a href="{{lien}}">ouvrir</a>')).toBe('<a href="{{lien}}">ouvrir</a>');
    expect(clean('<a href="%7B%7Blien%7D%7D">ouvrir</a>')).toBe('<a href="{{lien}}">ouvrir</a>');
  });

  it('is cleaned when saved, whatever the request carries', async () => {
    await call('PUT', '/email-templates/wallet_low', admin, {
      subject: 'x',
      body: '<p>{{message}}</p><script>steal()</script><img src="https://x.org/t.gif">',
    });
    const [row] = await t.db.select().from(emailTemplate);
    expect(row!.bodyHtml).toBe('<p>{{message}}</p>');
  });
});

describe('an edited e-mail is the one that is sent', () => {
  it('uses the new wording, fills the variables, and wraps it in the layout', async () => {
    await call('PUT', '/email-templates/password_link', admin, {
      subject: 'Bienvenue {{prenom}}',
      body: '<p>Salut {{prenom}}, c’est ici : <a href="{{lien}}">définir</a></p>',
    });
    const user = await createUser(t.db, { roles: [], email: 'marie@example.org' });
    await t.db.update(member).set({ firstName: 'Marie' }).where(eq(member.id, user.id));
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      headers: { 'x-episoft-csrf': '1' },
      payload: { username: user.username },
    });
    const [mail] = await outbox();
    expect(mail!.to).toBe('marie@example.org');
    expect(mail!.subject).toBe('Bienvenue Marie');
    expect(mail!.html).toMatch(/<a [^>]*href="http:\/\/test\.local\/mot-de-passe\?jeton=[^"]+"/);
    expect(mail!.html).toContain('Salut Marie');
    // The layout of the application is around it.
    expect(mail!.html).toContain('<!doctype html>');
    expect(mail!.html).toContain('Épicafé de Montjavoult');
    // The plain-text version carries the link too.
    expect(mail!.text).toMatch(/Salut Marie.*http:\/\/test\.local\/mot-de-passe\?jeton=/s);
  });

  it('escapes what a person typed: a first name cannot add HTML to the message', async () => {
    const user = await createUser(t.db, { roles: [], email: 'evil@example.org' });
    await t.db
      .update(member)
      .set({ firstName: '<img src=x onerror=alert(1)>' })
      .where(eq(member.id, user.id));
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      headers: { 'x-episoft-csrf': '1' },
      payload: { username: user.username },
    });
    const [mail] = await outbox();
    expect(mail!.html).not.toContain('<img src=x');
    expect(mail!.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('the e-mails to the team are templates too', async () => {
    await call('PUT', '/email-templates/alert_ticket_rejected', admin, {
      subject: 'Refus : {{motif}}',
      body: '<p>{{motif}}</p>',
    });
    await notifyStaff(
      t.db,
      t.config,
      ['ADMIN'],
      { template: 'alert_ticket_rejected', values: { motif: 'Total incohérent' } },
      { title: 't', body: 'b' },
    );
    const mails = (await outbox()).filter((m) => m.to === adminEmail);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('Refus : Total incohérent');
  });
});

describe('preview and test', () => {
  it('shows the draft with the samples of the variables, and what is wrong with it', async () => {
    const res = await call('POST', '/email-templates/wallet_low/preview', admin, {
      subject: 'Cagnotte de {{prenom}}',
      body: '<p>{{message}} {{inconnue}}</p>',
    });
    const p = res.json();
    expect(p.subject).toBe('Cagnotte de Marie');
    expect(p.html).toContain('Pensez à la recharger');
    expect(p.html).not.toContain('{{');
    expect(p.text).toContain('Pensez à la recharger');
    expect(p.problems).toEqual([expect.stringContaining('{{inconnue}}')]);
  });

  it('previews the saved wording when no draft is sent, and a draft is cleaned', async () => {
    const p = (await call('POST', '/email-templates/topup_receipt/preview', admin, {})).json();
    expect(p.subject).toBe('Épicafé : reçu de versement sur votre cagnotte');
    expect(p.problems).toEqual([]);
    const evil = (
      await call('POST', '/email-templates/wallet_low/preview', admin, {
        body: '<p>{{message}}</p><script>alert(1)</script>',
      })
    ).json();
    expect(evil.html).not.toContain('<script');
  });

  it('every e-mail of the application renders with its samples and leaves no variable behind', async () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const def = EMAIL_TEMPLATES.find((d) => d.key === key)!;
      const mail = await renderEmail(t.db, key, sampleValues(def), { preview: true });
      expect(mail.subject, key).not.toMatch(/\{\{|\n/);
      expect(mail.html, key).not.toContain('{{');
      expect(mail.text, key).not.toContain('{{');
      expect(mail.html, key).toContain('<!doctype html>');
    }
  });

  it('sends a test to the administrator with the label « Essai », and records it', async () => {
    expect((await call('POST', '/email-templates/wallet_low/test', admin)).statusCode).toBe(204);
    const [mail] = await outbox();
    expect(mail).toMatchObject({ to: adminEmail });
    expect(mail!.subject.startsWith('[Essai] ')).toBe(true);
    const { rows } = await t.db.execute<{ action: string }>(
      sql`select action from app.audit_log where action = 'email_template.test'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a test when the administrator has no e-mail address', async () => {
    const noMail = await login(
      t.app,
      (await createUser(t.db, { roles: ['ADMIN'], email: null })).username!,
    );
    expect((await call('POST', '/email-templates/wallet_low/test', noMail)).statusCode).toBe(400);
  });
});

describe('the layout common to every e-mail', () => {
  const layout = (over: object = {}) => ({
    headerImageId: null,
    headerAlt: 'Logo',
    footerHtml: '<p>Association loi 1901 — <a href="https://exemple.org">site</a></p>',
    accentColor: '#aa3300',
    ...over,
  });

  it('applies its colour and footer to the messages', async () => {
    expect((await call('PUT', '/email-layout', admin, layout())).statusCode).toBe(200);
    expect((await call('GET', '/email-layout', admin)).json()).toMatchObject({
      accentColor: '#aa3300',
    });
    await call('POST', '/email-templates/wallet_low/test', admin);
    const [mail] = await outbox();
    expect(mail!.html).toContain('#aa3300');
    expect(mail!.html).toContain('Association loi 1901');
    expect(mail!.text).toContain('Association loi 1901');
  });

  it('refuses a colour that is not a colour, and cleans the footer', async () => {
    expect(
      (await call('PUT', '/email-layout', admin, layout({ accentColor: 'red;x' }))).statusCode,
    ).toBe(400);
    await call(
      'PUT',
      '/email-layout',
      admin,
      layout({ footerHtml: '<p>ok</p><script>x()</script>' }),
    );
    expect((await call('GET', '/email-layout', admin)).json().footerHtml).toBe('<p>ok</p>');
  });

  it('refuses a header image that does not exist', async () => {
    const res = await call(
      'PUT',
      '/email-layout',
      admin,
      layout({ headerImageId: '0190a0a0-0000-7000-8000-0000000000aa' }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('the images of the e-mails', () => {
  it('stores an image, shows it to the administrators only, and lists it', async () => {
    const res = await upload(admin, PNG);
    expect(res.statusCode).toBe(200);
    const { id } = res.json();
    const got = await call('GET', `/email-assets/${id}`, admin);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(got.rawPayload, PNG)).toBe(0);
    expect((await call('GET', `/email-assets/${id}`, other)).statusCode).toBe(403);
    expect((await call('GET', `/email-assets/${id}`, { 'x-episoft-csrf': '1' })).statusCode).toBe(
      401,
    );
    const list = (await call('GET', '/email-assets', admin)).json();
    expect(list).toEqual([
      expect.objectContaining({ id, name: 'logo.png', mime: 'image/png', usedBy: [] }),
    ]);
  });

  it('refuses what is not an image, an SVG, a wrong type and an image that is too big', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect((await upload(admin, html, 'image/png')).statusCode).toBe(400);
    expect(
      (await upload(admin, Buffer.from('<svg onload="x()"/>'), 'image/svg+xml')).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect((await upload(admin, PNG, 'application/pdf')).statusCode).toBeGreaterThanOrEqual(400);
    const big = Buffer.concat([PNG, Buffer.alloc(501 * 1024)]);
    expect((await upload(admin, big)).statusCode).toBe(413);
    expect(await t.db.select().from(emailAsset)).toHaveLength(0);
  });

  it('puts the images inside the message, not as a link to the server', async () => {
    const { id } = (await upload(admin, PNG)).json();
    await call('PUT', '/email-layout', admin, {
      headerImageId: id,
      headerAlt: 'Logo',
      footerHtml: '<p>pied</p>',
      accentColor: '#14532d',
    });
    await call('PUT', '/email-templates/wallet_low', admin, {
      subject: 'x',
      body: `<p>{{message}}</p><img src="/api/v1/email-assets/${id}" alt="Photo">`,
    });
    await call('POST', '/email-templates/wallet_low/test', admin);
    const mail = (await outbox()).find((m) => m.subject.startsWith('[Essai]'))!;
    expect(mail.html).toContain(`cid:asset-${id}@episoft`);
    expect(mail.html).not.toContain('/api/v1/email-assets/');
    const parts = mail.attachments as {
      cid?: string;
      contentType: string;
      contentBase64: string;
    }[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ cid: `asset-${id}@episoft`, contentType: 'image/png' });
    expect(Buffer.from(parts[0]!.contentBase64, 'base64').equals(PNG)).toBe(true);

    // The journal of e-mails shows the image, and does not list it as an attachment.
    const view = (await call('GET', `/admin/emails/${mail.id}`, admin)).json();
    expect(view.html).toContain('data:image/png;base64,');
    expect(view.html).not.toContain('cid:');
    expect(view.attachments).toEqual([]);
    expect(view.files).toEqual([]);
  });

  it('shows the images in a preview as data, so that a sandboxed frame can display them', async () => {
    const { id } = (await upload(admin, PNG)).json();
    const p = (
      await call('POST', '/email-templates/wallet_low/preview', admin, {
        body: `<p>{{message}}</p><img src="/api/v1/email-assets/${id}">`,
      })
    ).json();
    expect(p.html).toContain('data:image/png;base64,');
    expect(p.html).not.toContain('/api/v1/email-assets/');
  });

  it('does not delete an image that is used, and deletes one that is not', async () => {
    const { id } = (await upload(admin, PNG)).json();
    await call('PUT', '/email-templates/wallet_low', admin, {
      subject: 'x',
      body: `<p>{{message}}</p><img src="/api/v1/email-assets/${id}">`,
    });
    const used = await call('DELETE', `/email-assets/${id}`, admin);
    expect(used.statusCode).toBe(409);
    expect(used.json().detail).toContain('Cagnotte basse');
    await call('DELETE', '/email-templates/wallet_low', admin);
    expect((await call('DELETE', `/email-assets/${id}`, admin)).statusCode).toBe(204);
    expect(await t.db.select().from(emailAsset)).toHaveLength(0);
  });

  it('a message still reads when its image was deleted since', async () => {
    const { id } = (await upload(admin, PNG)).json();
    await call('PUT', '/email-templates/wallet_low', admin, {
      subject: 'x',
      body: `<p>{{message}}</p><img src="/api/v1/email-assets/${id}">`,
    });
    await t.db.delete(emailAsset).where(eq(emailAsset.id, id));
    await call('POST', '/email-templates/wallet_low/test', admin);
    const [mail] = await outbox();
    expect(mail!.html).not.toContain('<img src="cid:');
    expect(mail!.html).not.toContain('/api/v1/email-assets/');
    expect(mail!.html).toContain('Pensez à la recharger');
  });
});

describe('an e-mail never costs the business change it follows', () => {
  it('goes out in the original wording when the edited one cannot be read, and the change stays', async () => {
    const values = { prenom: 'Marie', numero: 'P-1', date_retrait: '20/11/2026' };
    await t.db.transaction(async (tx) => {
      // Reading the wording fails (a table that is not there): without a savepoint this would abort
      // the whole transaction, and with it the sale, the top-up or the closing it belongs to.
      await tx.execute(sql`alter table app.email_template rename to email_template_off`);
      await queueTemplatedEmail(tx, 'preorder_ready', 'marie@example.org', values);
      await tx.execute(sql`alter table app.email_template_off rename to email_template`);
    });
    const [mail] = await outbox();
    expect(mail!.to).toBe('marie@example.org');
    expect(mail!.subject).toBe('Épicafé : votre commande P-1 est prête');
    expect(mail!.html).toContain('<strong>P-1</strong>');
    expect(mail!.html).not.toMatch(/\{\{/);
    expect(mail!.text).toContain('Bonjour Marie');
  });
});

describe('the images inside a sent message', () => {
  it('are not kept in the outbox once sent, the attachments are', () => {
    const pdf = { filename: 'a.pdf', contentType: 'application/pdf', contentBase64: 'AAAA' };
    const img = { ...pdf, filename: 'h.png', contentType: 'image/png', cid: 'asset-x@episoft' };
    expect(withoutInlineImages([img, pdf])).toEqual([pdf]);
    expect(withoutInlineImages([img])).toBeNull();
    expect(withoutInlineImages(null)).toBeNull();
  });
});
