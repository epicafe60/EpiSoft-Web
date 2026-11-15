import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { emailOutbox } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

// The name, the logo and the colour of the application are settings (public to read, admin to write).

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Awaited<ReturnType<typeof login>>;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const base = {
  appName: 'EpiSoft',
  shortName: 'Épicafé',
  accentColor: '#14532d',
  logoImageId: null as string | null,
};

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(sql`truncate app.email_template, app.email_asset, app.email_outbox cascade`);
  const a = await createUser(t.db, { roles: ['ADMIN'] });
  admin = await login(t.app, a.username!);
});

const put = (payload: object) =>
  t.app.inject({ method: 'PUT', url: '/api/v1/settings/app.branding', headers: admin, payload });
const upload = async () =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/email-assets',
      headers: { ...admin, 'content-type': 'image/png', 'x-file-name': 'logo.png' },
      payload: PNG,
    })
  ).json().id as string;

describe('GET /branding (public)', () => {
  it('gives the names and logo of the Épicafé until the association sets its own', async () => {
    const res = await t.app.inject({ url: '/api/v1/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      appName: 'EpiSoft',
      shortName: 'Épicafé',
      associationName: 'Épicafé de Montjavoult',
      accentColor: '#14532d',
      logoUrl: '/logo.png',
      customLogo: false,
    });
  });

  it('follows what an administrator saves, and the manifest with it', async () => {
    const logoImageId = await upload();
    const saved = await put({
      appName: 'GestEpicerie',
      shortName: 'Le Panier',
      accentColor: '#1d4ed8',
      logoImageId,
    });
    expect(saved.statusCode).toBe(200);

    const info = (await t.app.inject({ url: '/api/v1/branding' })).json();
    expect(info).toMatchObject({
      appName: 'GestEpicerie',
      shortName: 'Le Panier',
      accentColor: '#1d4ed8',
      logoUrl: `/api/v1/branding/logo/${logoImageId}`,
      customLogo: true,
    });

    const manifest = await t.app.inject({ url: '/api/v1/branding/manifest.webmanifest' });
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.json()).toMatchObject({
      short_name: 'GestEpicerie',
      theme_color: '#1d4ed8',
      icons: [{ src: `/api/v1/branding/logo/${logoImageId}`, type: 'image/png' }],
    });

    const logo = await t.app.inject({ url: `/api/v1/branding/logo/${logoImageId}` });
    expect(logo.statusCode).toBe(200);
    expect(Buffer.compare(logo.rawPayload, PNG)).toBe(0);
  });

  it('serves the chosen logo only: the rest of the library stays private', async () => {
    const chosen = await upload();
    const other = await upload();
    expect((await t.app.inject({ url: `/api/v1/branding/logo/${other}` })).statusCode).toBe(404);
    await put({ ...base, logoImageId: chosen });
    expect((await t.app.inject({ url: `/api/v1/branding/logo/${chosen}` })).statusCode).toBe(200);
    expect((await t.app.inject({ url: `/api/v1/branding/logo/${other}` })).statusCode).toBe(404);
  });
});

describe('PUT /settings/app.branding', () => {
  it('is reserved to the administrators', async () => {
    const u = await createUser(t.db, { roles: ['CAISSE'] });
    const headers = await login(t.app, u.username!);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/app.branding',
      headers,
      payload: base,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a colour that is too light, an unknown logo and an empty name', async () => {
    expect((await put({ ...base, accentColor: '#ffee00' })).statusCode).toBe(400);
    expect((await put({ ...base, appName: '' })).statusCode).toBe(400);
    const unknown = await put({ ...base, logoImageId: '0190a0a0-0000-7000-8000-0000000000aa' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().detail).toMatch(/logo/);
  });

  it('keeps the logo in use: the library does not delete it', async () => {
    const id = await upload();
    await put({ ...base, logoImageId: id });
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/email-assets/${id}`,
      headers: admin,
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().detail).toMatch(/Logo de l’application/);
  });
});

describe('e-mails use the names set by the association', () => {
  it('writes the short name and the software name in the e-mail', async () => {
    await put({ ...base, appName: 'GestEpicerie', shortName: 'Le Panier' });
    const user = await createUser(t.db, { roles: [], email: 'marie@example.org' });
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      headers: { 'x-episoft-csrf': '1' },
      payload: { username: user.username },
    });
    const [mail] = await t.db.select().from(emailOutbox);
    expect(mail!.subject).toBe('Le Panier : définir votre mot de passe');
    expect(mail!.html).toContain('mot de passe GestEpicerie');
    expect(mail!.html).not.toContain('EpiSoft');
  });
});
