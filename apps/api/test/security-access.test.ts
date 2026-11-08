import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createDb,
  createPool,
  emailOutbox,
  media,
  member,
  passwordResetToken,
  product,
} from '@episoft/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createUser, csrf, login, setupTestApp } from './helpers';

// Corrections of the KV2 audit, lot A (access): S01, S02, S04, C05. Each test fails on the code
// the audit examined and passes after the correction.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const get = (url: string, headers: Headers = {}) => t.app.inject({ url, headers });

async function productImage() {
  const [m] = await t.db
    .insert(media)
    .values({ mime: 'image/png', bytes: Buffer.from('png') })
    .returning();
  await t.db
    .insert(product)
    .values({ code: '900001', name: 'Savon', salePrice: '3.00', imageId: m!.id });
  return m!.id;
}

async function invoiceWithDocument() {
  const [doc] = await t.db
    .insert(media)
    .values({ mime: 'application/pdf', bytes: Buffer.from('%PDF facture') })
    .returning();
  const { rows } = await t.db.execute<{ id: string }>(sql`
    with s as (insert into app.supplier (id, code, name) values (gen_random_uuid(), 'FSEC', 'Fournisseur')
               returning id)
    insert into app.supplier_invoice (id, supplier_id, piece_ref, date, due_date, total_excl, total_vat, total_incl,
                                      document_media_id)
    select gen_random_uuid(), s.id, 'F-2026/01', current_date, current_date, 10, 0.55, 10.55, ${doc!.id}
    from s returning id`);
  return { invoiceId: rows[0]!.id, mediaId: doc!.id };
}

describe('S01 — the protections do not depend on how the path is written', () => {
  it('refuses an encoded API path without a session, like the plain one', async () => {
    const id = await productImage();
    const { mediaId } = await invoiceWithDocument();
    for (const path of [
      `/api/v1/media/${mediaId}`,
      `/%61pi/v1/media/${mediaId}`,
      `/%61%70%69/v1/media/${id}`,
      '/%61pi/v1/members',
      '/%41PI/v1/members',
    ])
      expect((await get(path)).statusCode, path).toBe(401);
  });

  it('refuses an expired session, on the plain and on the encoded path', async () => {
    const u = await createUser(t.db, { roles: ['ADMIN'] });
    const h = await login(t.app, u.username!);
    await t.db.execute(sql`update app.session set expires_at = now() - interval '1 minute'`);
    for (const path of ['/api/v1/members', '/%61pi/v1/members'])
      expect((await get(path, h)).statusCode, path).toBe(401);
  });

  it('asks for the anti-CSRF header on an encoded path too', async () => {
    const plain = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    const encoded = await t.app.inject({ method: 'POST', url: '/%61pi/v1/auth/logout' });
    expect(plain.statusCode).toBe(403);
    expect(encoded.statusCode).toBe(403);
  });

  it('still lets the public routes answer', async () => {
    expect((await get('/api/v1/health')).statusCode).toBe(200);
  });
});

describe('a request without a session, and the rate limits', () => {
  it('is refused before its body is read or checked', async () => {
    // An upload larger than the route accepts: refused for the missing session (401), not for its
    // size (413), so nobody signed out can make the server buffer files.
    const upload = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/supplier-invoices/${randomUUID()}/document`,
      headers: { ...csrf, 'content-type': 'application/pdf' },
      payload: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    expect(upload.statusCode).toBe(401);
    // An invalid body: no description of the expected fields for someone signed out.
    const invalid = await t.app.inject({
      method: 'POST',
      url: '/api/v1/pos/devices',
      headers: csrf,
      payload: { nope: true },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().errors).toBeUndefined();
  });

  it('counts per real session: a made-up cookie on each request gets no fresh counter', async () => {
    const pool = createPool(inject('appDatabaseUrl'), 1);
    const strict = await buildApp(
      createDb(pool),
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: inject('appDatabaseUrl'),
        AUTH_RATE_LIMIT_MAX: '3',
      }),
    );
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await strict.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { ...csrf, cookie: `episoft_session=${randomUUID()}` },
          payload: { username: `inconnu${i}`, password: 'mauvais mot de passe' },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await strict.close();
      await pool.end();
    }
  });
});

describe('S02 — the sign-in identity of a staff account', () => {
  it('cannot be changed by the members team, only by an administrator', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const team = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const card = (await get(`/api/v1/members/${admin.id}`, team)).json() as { updatedAt: string };
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${admin.id}`,
      headers: team,
      payload: { updatedAt: card.updatedAt, email: 'pirate@example.org' },
    });
    expect(res.statusCode).toBe(403);
    const asUser = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${admin.id}`,
      headers: team,
      payload: { updatedAt: card.updatedAt, username: 'pirate' },
    });
    expect(asUser.statusCode).toBe(403);
    const [still] = await t.db.select().from(member).where(eq(member.id, admin.id));
    expect(still).toMatchObject({ email: admin.email, username: admin.username });
    // The rest of the card stays editable by the team.
    const phone = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${admin.id}`,
      headers: team,
      payload: { updatedAt: card.updatedAt, phone: '06 11 22 33 44' },
    });
    expect(phone.statusCode, phone.body).toBe(200);
  });

  it('cannot be deactivated by the members team (it would lock the administrators out)', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const adminH = await login(t.app, admin.username!);
    const team = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    for (const status of ['INACTIVE', 'ARCHIVED']) {
      const card = (await get(`/api/v1/members/${admin.id}`, team)).json() as { updatedAt: string };
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/members/${admin.id}`,
        headers: team,
        payload: { updatedAt: card.updatedAt, status },
      });
      expect(res.statusCode, status).toBe(403);
    }
    // Still signed in, still able to sign in.
    expect((await get('/api/v1/me', adminH)).statusCode).toBe(200);
    // An ordinary member is still deactivated by the team.
    const plain = await createUser(t.db, { roles: [] });
    const card = (await get(`/api/v1/members/${plain.id}`, team)).json() as { updatedAt: string };
    const ok = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${plain.id}`,
      headers: team,
      payload: { updatedAt: card.updatedAt, status: 'INACTIVE' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('is changed by an administrator: the old address is told and the reset links are revoked', async () => {
    const cashier = await createUser(t.db, { roles: ['CAISSE'] });
    const old = cashier.email!;
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      headers: csrf,
      payload: { username: cashier.username },
    });
    const adminH = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    const card = (await get(`/api/v1/members/${cashier.id}`, adminH)).json() as {
      updatedAt: string;
    };
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${cashier.id}`,
      headers: adminH,
      payload: { updatedAt: card.updatedAt, email: 'nouvelle@example.org' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const told = await t.db.select().from(emailOutbox).where(eq(emailOutbox.to, old));
    expect(told.map((m) => m.subject)).toContain('Épicafé : l’adresse de votre compte a changé');
    const open = await t.db
      .select()
      .from(passwordResetToken)
      .where(
        sql`${passwordResetToken.memberId} = ${cashier.id} and ${passwordResetToken.usedAt} is null`,
      );
    expect(open).toEqual([]);
  });

  it('leaves an ordinary member card fully editable by the members team', async () => {
    const plain = await createUser(t.db, { roles: [] });
    const team = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const card = (await get(`/api/v1/members/${plain.id}`, team)).json() as { updatedAt: string };
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${plain.id}`,
      headers: team,
      payload: { updatedAt: card.updatedAt, email: 'autre@example.org' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('cannot be changed through the member import by the members team', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const team = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
    const c = Array.from({ length: 14 }, () => '');
    c[2] = admin.firstName;
    c[3] = admin.lastName;
    c[6] = 'pirate@example.org';
    const file = `${Array.from({ length: 14 }, (_, i) => `H${i}`).join(';')}\n${c.join(';')}`;
    const send = (path: string) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1${path}`,
        payload: Buffer.from(file, 'utf-8'),
        headers: { ...team, 'content-type': 'application/octet-stream', 'x-file-name': 'm.csv' },
      });
    const preview = (await send('/imports/members/preview')).json();
    expect(preview.counts.error).toBe(1);
    await send('/imports/members/apply');
    const [still] = await t.db.select().from(member).where(eq(member.id, admin.id));
    expect(still!.email).toBe(admin.email);
  });
});

describe('S04 — one valid reset link at a time', () => {
  it('a second link is no longer valid once the first one was used, nor an older one', async () => {
    const u = await createUser(t.db);
    const ask = async () => {
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        headers: csrf,
        payload: { username: u.username },
      });
      const mails = await t.db.select().from(emailOutbox).where(eq(emailOutbox.to, u.email!));
      const last = mails.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      return decodeURIComponent(/jeton=([^\s"<]+)/.exec(last.text!)![1]!);
    };
    const first = await ask();
    const second = await ask();
    const reset = (token: string, password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/reset',
        headers: csrf,
        payload: { token, password },
      });
    // Asking again made the first link unusable.
    expect((await reset(first, 'un mot de passe tout neuf')).statusCode).toBe(400);
    expect((await reset(second, 'un mot de passe tout neuf')).statusCode).toBe(204);
    // And after a reset, no link of the member is left open.
    const third = await ask();
    expect((await reset(third, 'encore un autre mot de passe')).statusCode).toBe(204);
    expect((await reset(second, 'et un dernier mot de passe')).statusCode).toBe(400);
  });
});

describe('C05 — invoice documents', () => {
  it('are not served by the product image route, to anyone', async () => {
    const { mediaId } = await invoiceWithDocument();
    const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
    expect((await get(`/api/v1/media/${mediaId}`, admin)).statusCode).toBe(404);
  });

  it('are served by their own route to APPROS and COMPTA only, never cached', async () => {
    const { invoiceId } = await invoiceWithDocument();
    const url = `/api/v1/supplier-invoices/${invoiceId}/document`;
    for (const roles of [['APPROS'], ['COMPTA']] as const) {
      const h = await login(t.app, (await createUser(t.db, { roles: [...roles] })).username!);
      const res = await get(url, h);
      expect(res.statusCode, roles.join()).toBe(200);
      expect(res.body).toBe('%PDF facture');
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
    const member = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    expect((await get(url, member)).statusCode).toBe(403);
    expect((await get(url)).statusCode).toBe(401);
    expect(
      (await get(`/api/v1/supplier-invoices/${randomUUID()}/document`, member)).statusCode,
    ).toBe(403);
  });

  it('leave product images visible to every signed-in person', async () => {
    const id = await productImage();
    const someone = await login(t.app, (await createUser(t.db, { roles: [] })).username!);
    const res = await get(`/api/v1/media/${id}`, someone);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });
});

describe('D01 — the application role reads and writes the data, nothing more', () => {
  it('cannot change the structure, rewrite the journals or switch off their guard', async () => {
    const pool = createPool(inject('appDatabaseUrl'), 1, 'test');
    const app = createDb(pool);
    const refused = async (q: ReturnType<typeof sql>) => {
      const e = await app.execute(q).then(
        () => null,
        (err: { cause?: { code?: string }; code?: string }) => err.cause?.code ?? err.code,
      );
      return e;
    };
    try {
      // 42501: insufficient privilege; 42P01 would mean the table is not even visible.
      expect(await refused(sql`drop table app.member`)).toBe('42501');
      expect(await refused(sql`alter table app.audit_log disable trigger all`)).toBe('42501');
      expect(await refused(sql`create table app.intruder (id int)`)).toBe('42501');
      expect(await refused(sql`truncate app.audit_log`)).toBe('42501');
      expect(await refused(sql`delete from app.audit_log`)).toBe('42501');
      expect(await refused(sql`delete from app."__drizzle_migrations"`)).toBe('42501');
      // The anonymisation switch does not open the journals to this role.
      await app
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('episoft.scrub', 'on', true)`);
          const e = await tx.execute(sql`update app.data_change set old = null`).then(
            () => null,
            (err: { cause?: { code?: string } }) => err.cause?.code,
          );
          expect(e).toBe('42501');
          tx.rollback();
        })
        .catch((e: Error) => {
          if (!/rollback/i.test(e.message)) throw e;
        });
      // What it is for still works: reading and writing the data, the tables of the next
      // migrations too (created by the owner: default privileges of split-roles.sql).
      expect(await refused(sql`select count(*) from app.member`)).toBeNull();
      await t.db.transaction(async (tx) => {
        await tx.execute(sql`set local role episoft_owner`);
        await tx.execute(sql`create table app.d01_probe (id int primary key)`);
      });
      try {
        expect(await refused(sql`insert into app.d01_probe values (1)`)).toBeNull();
      } finally {
        await t.db.execute(sql`drop table app.d01_probe`);
      }
    } finally {
      await pool.end();
    }
  });
});

describe('files sent to the server', () => {
  it('refuses a page or an SVG passed off as an image, and a zip bomb as a spreadsheet', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
    const [p] = await t.db
      .insert(product)
      .values({ code: '900002', name: 'Thé', salePrice: '4.00' })
      .returning();
    for (const body of ['<html><script>alert(1)</script>', '<svg onload="alert(1)"/>']) {
      const res = await t.app.inject({
        method: 'PUT',
        url: `/api/v1/products/${p!.id}/image`,
        headers: { ...h, 'content-type': 'image/png' },
        payload: Buffer.from(body),
      });
      expect(res.statusCode, body).toBe(400);
    }
    // An archive announcing 4 GB once unpacked, sent as a 100-byte .xlsx.
    const bomb = Buffer.alloc(47 + 22);
    bomb.writeUInt32LE(0x02014b50, 0);
    bomb.writeUInt32LE(0xfffffffe, 24);
    bomb.writeUInt16LE(1, 28);
    bomb.writeUInt32LE(0x06054b50, 47);
    bomb.writeUInt16LE(1, 57);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/imports/products/preview?profile=epicerio',
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': 'bombe.xlsx' },
      payload: bomb,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().detail).toMatch(/volumineux/);
  });

  it('answers a malformed import option with a 400, not a server error', async () => {
    const h = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
    for (const [name, value] of [
      ['supplierMap', '{oops'],
      ['supplierMap', '{"Bio":"pas-un-id"}'],
      ['mapping', '[1'],
    ] as const) {
      const option = `${name}=${encodeURIComponent(value)}`;
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: `/api/v1/imports/products/preview?profile=custom&${option}`,
            headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': 'p.csv' },
            payload: Buffer.from('code;nom\n1;Miel\n'),
          })
        ).statusCode,
        option,
      ).toBe(400);
    }
  });
});
