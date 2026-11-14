import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ROLE_CODES, type RoleCode } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';

// « Exporter en Excel » on every list: the role of the screen decides, the content is checked.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const body = (scope: string, over: object = {}) => ({
  scope,
  title: 'Liste des membres',
  columns: [
    { header: 'Nom', type: 'text' },
    { header: 'Solde', type: 'money' },
    { header: 'Depuis', type: 'date' },
    { header: 'Vu le', type: 'datetime' },
  ],
  rows: [
    ['DUPONT', 12.5, '2026-11-14', '2026-11-14T10:30'],
    ['=1+1', -3, '2026-01-02', null],
  ],
  ...over,
});

const send = (headers: Headers, payload: object) =>
  t.app.inject({ method: 'POST', url: '/api/v1/exports/table', headers, payload });

const as = async (roles: RoleCode[]) => login(t.app, (await createUser(t.db, { roles })).username!);

describe('the role of the screen decides', () => {
  it('lets the roles of a screen export it, and an administrator export any', async () => {
    expect((await send(await as(['ADHERENTS']), body('membres'))).statusCode).toBe(200);
    expect((await send(await as(['COMPTA']), body('compta'))).statusCode).toBe(200);
    expect((await send(await as(['ADMIN']), body('compta'))).statusCode).toBe(200);
    expect((await send(await as(['ADMIN']), body('admin'))).statusCode).toBe(200);
  });

  it('refuses a role that does not open the screen, whatever it sends', async () => {
    const cashier = await as(['CAISSE']);
    for (const scope of ['membres', 'compta', 'appros', 'admin', 'surveillance', 'stats'])
      expect((await send(cashier, body(scope))).statusCode).toBe(403);
    // A person with no role at all exports nothing but their own screens.
    const nobody = await as([]);
    expect((await send(nobody, body('membres'))).statusCode).toBe(403);
    expect((await send(nobody, body('signalements-gestion'))).statusCode).toBe(403);
    expect((await send(nobody, body('perso'))).statusCode).toBe(200);
    expect((await send(nobody, body('accueil'))).statusCode).toBe(200);
  });

  it('keeps the administration for the administrators, whatever the other role', async () => {
    for (const role of ROLE_CODES.filter((r) => r !== 'ADMIN'))
      expect((await send(await as([role]), body('admin'))).statusCode).toBe(403);
  });

  it('answers 401 without a session and 403 while another cashier keeps the till', async () => {
    expect((await send({ 'x-episoft-csrf': '1' }, body('perso'))).statusCode).toBe(401);
    const cashier = await createUser(t.db, { roles: ['CAISSE', 'ADHERENTS'] });
    const h = await login(t.app, cashier.username!);
    const other = await createUser(t.db, { roles: ['CAISSE'] });
    await t.db.execute(
      sql`update app.session set till_cashier_id = ${other.id} where member_id = ${cashier.id}`,
    );
    const res = await send(h, body('membres'));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('TILL_LOCKED');
  });
});

describe('the file', () => {
  it('holds the list with real amounts and dates, and a text never becomes a formula', async () => {
    const res = await send(await as(['ADHERENTS']), body('membres'));
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="Liste-des-membres-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as never);
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe('Liste des membres');
    expect(ws.getRow(1).values).toEqual([undefined, 'Nom', 'Solde', 'Depuis', 'Vu le']);
    expect(ws.getCell('B2').value).toBe(12.5);
    expect(ws.getCell('B2').numFmt).toBe('#,##0.00 €');
    expect((ws.getCell('C2').value as Date).toISOString()).toBe('2026-11-14T00:00:00.000Z');
    expect((ws.getCell('D2').value as Date).toISOString()).toBe('2026-11-14T10:30:00.000Z');
    expect(ws.getCell('D3').value).toBeNull();
    const injected = ws.getCell('A3');
    expect(injected.value).toBe('=1+1');
    expect(injected.type).toBe(ExcelJS.ValueType.String);
  });

  it('is recorded in the journal: who, from which screen, how many rows', async () => {
    await send(await as(['ADHERENTS']), body('membres'));
    const { rows } = await t.db.execute<{ action: string; after: Record<string, unknown> }>(
      sql`select action, after from app.audit_log where action = 'export.file'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ scope: 'membres', rows: 2, columns: 4 });
  });

  it('refuses a malformed, mistyped or oversized request', async () => {
    const h = await as(['ADMIN']);
    for (const bad of [
      body('inconnu'),
      body('membres', { rows: [['A', 1]] }),
      body('membres', { rows: [['A', '12,50', '2026-11-14', null]] }),
      body('membres', { rows: [['A', 1, '14/11/2026', null]] }),
      body('membres', { title: '  ' }),
      body('membres', { columns: [] }),
    ])
      expect((await send(h, bad)).statusCode).toBe(400);
    const many = Array.from({ length: 20_001 }, () => ['A', 1, '2026-11-14', null]);
    expect((await send(h, body('membres', { rows: many }))).statusCode).toBe(400);
  });

  it('writes a file name that cannot escape: letters, digits and dashes', async () => {
    const res = await send(
      await as(['ADMIN']),
      body('admin', { title: '../../évil\r\nX-Injected: 1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="[A-Za-z0-9-]+\.xlsx"$/,
    );
    expect(res.headers['x-injected']).toBeUndefined();
  });
});
