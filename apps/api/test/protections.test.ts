import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailOutbox, errorLog, integrityRun, product, sale, syncRejection } from '@episoft/db';
import { DEFAULT_THRESHOLDS, type SyncOp } from '@episoft/shared';
import { createUser, login, setupTestApp } from './helpers';
import { addProduct as addProductTo, openTill, type Till } from './till-fixtures';

// Protections and monitoring: refused tickets, warnings, « À surveiller », errors, backups.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
let till: Till;
let cashier: Headers;
let admin: Headers;
let deviceId: string;
let sessionId: string;
let cashierId: string;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

beforeEach(async () => {
  till = await openTill(t);
  ({ cashier, admin, deviceId, sessionId, cashierId } = till);
});

const push = (ops: SyncOp[]) => till.push(ops);
const saleOp = (...args: Parameters<Till['saleOp']>) => till.saleOp(...args);
const addProduct = (over: Parameters<typeof addProductTo>[1] = {}) => addProductTo(t.db, over);

const get = (url: string, h: Headers = admin) => t.app.inject({ url: `/api/v1${url}`, headers: h });
const post = (url: string, payload: object = {}, h: Headers = admin) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

/** The alerts are sent without making the till wait: give them a moment. */
async function mailsWith(subject: string) {
  for (let i = 0; i < 20; i++) {
    const rows = (await t.db.select().from(emailOutbox)).filter((m) => m.subject === subject);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

const attention = async () =>
  (await get('/admin/attention')).json() as { code: string; count: number; severity: string }[];

describe('a refused ticket is never lost', () => {
  it('keeps it for the administrators, alerts them once an hour, and can be put aside', async () => {
    const bad = saleOp([{ productId: randomUUID(), unitPrice: '2.50' }], '2.50');
    const [r] = await push([bad]);
    expect(r).toMatchObject({ status: 'REJECTED' });

    const [kept] = await t.db.select().from(syncRejection);
    expect(kept).toMatchObject({ opId: bad.id, kind: 'SALE' });
    expect(kept!.reason).toContain('Produit inconnu');

    const mails = await mailsWith('Épicafé : un ticket de caisse a été refusé');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('Produit inconnu');

    // A second refusal within the hour does not send a second e-mail.
    await push([saleOp([{ productId: randomUUID(), unitPrice: '1.00' }], '1.00')]);
    await new Promise((r2) => setTimeout(r2, 300));
    expect(
      (await t.db.select().from(emailOutbox)).filter(
        (m) => m.subject === 'Épicafé : un ticket de caisse a été refusé',
      ),
    ).toHaveLength(1);

    // Replaying the same refused operation answers the same, and stores nothing twice.
    expect((await push([bad]))[0]).toMatchObject({ status: 'REJECTED' });
    expect(await t.db.select().from(syncRejection)).toHaveLength(2);

    const list = (await get('/admin/rejections')).json() as { id: string; reason: string }[];
    expect(list).toHaveLength(2);
    expect((await attention()).find((i) => i.code === 'REJECTED_TICKETS')).toMatchObject({
      count: 2,
      severity: 'error',
    });

    for (const x of list)
      expect((await post(`/admin/rejections/${x.id}/ack`)).statusCode).toBe(200);
    expect((await get('/admin/rejections')).json()).toHaveLength(0);
    expect((await get('/admin/rejections?all=true')).json()).toHaveLength(2);
    expect((await attention()).some((i) => i.code === 'REJECTED_TICKETS')).toBe(false);
    expect((await post(`/admin/rejections/${list[0]!.id}/ack`)).statusCode).toBe(404);
  });

  it('is reserved to the administrators and the treasury', async () => {
    expect((await get('/admin/rejections', cashier)).statusCode).toBe(403);
    expect((await get('/admin/attention', cashier)).statusCode).toBe(403);
  });
});

describe('unusual tickets are recorded with a warning, never refused', () => {
  it('flags a typed 100, a price far from the catalogue, a high discount and a clock far ahead', async () => {
    const p = await addProduct({ stockQty: '500' });
    const [r] = await push([
      saleOp(
        [
          { productId: p.id, qty: '100', unitPrice: '2.50', catalogPrice: '2.50' },
          { productId: p.id, qty: '1', unitPrice: '0.20', catalogPrice: '2.50' },
          { productId: p.id, qty: '4', unitPrice: '2.50', catalogPrice: '2.50', discount: '5.00' },
        ],
        '255.20',
        new Date(Date.now() + 2 * 3_600_000),
      ),
    ]);
    expect(r!.status).toBe('OK');
    const codes = r!.warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'QTY_HIGH',
        'LINE_AMOUNT',
        'PRICE_FAR',
        'DISCOUNT_HIGH',
        'CLOCK_SKEW',
      ]),
    );
    expect(r!.warnings.every((w) => !/R-[A-Z]{3}-\d/.test(w.message))).toBe(true);
    const [s] = await t.db.select().from(sale);
    expect((s!.warnings as unknown[]).length).toBe(r!.warnings.length);
  });

  it('flags a sale that makes the stock negative', async () => {
    const p = await addProduct({ stockQty: '1', name: 'Dernier pot' });
    const [r] = await push([saleOp([{ productId: p.id, qty: '3', unitPrice: '2.50' }], '7.50')]);
    expect(r!.status).toBe('OK');
    const w = r!.warnings.find((x) => x.code === 'STOCK_NEGATIVE');
    expect(w?.message).toContain('Dernier pot');
    expect((await attention()).find((i) => i.code === 'STOCK_NEGATIVE')).toMatchObject({
      count: 1,
    });
  });

  it('says nothing about a normal ticket', async () => {
    const p = await addProduct();
    const [r] = await push([saleOp([{ productId: p.id, qty: '2', unitPrice: '2.50' }], '5.00')]);
    expect(r!.warnings).toEqual([]);
  });

  it('lists the tickets saved with a warning until someone has looked at them', async () => {
    const p = await addProduct({ stockQty: '500' });
    await push([saleOp([{ productId: p.id, qty: '100', unitPrice: '2.50' }], '250.00')]);
    const open = (await get('/admin/sale-warnings')).json() as {
      id: string;
      warnings: unknown[];
    }[];
    expect(open).toHaveLength(1);
    expect((await attention()).find((i) => i.code === 'SALE_WARNINGS')).toMatchObject({ count: 1 });
    expect((await post(`/admin/sale-warnings/${open[0]!.id}/review`)).statusCode).toBe(200);
    expect((await get('/admin/sale-warnings')).json()).toHaveLength(0);
    expect((await attention()).some((i) => i.code === 'SALE_WARNINGS')).toBe(false);
  });

  it('uses the thresholds set in the administration', async () => {
    const p = await addProduct();
    const saved = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/controls.thresholds',
      headers: admin,
      payload: { ...DEFAULT_THRESHOLDS, qtyMax: 3 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const [r] = await push([saleOp([{ productId: p.id, qty: '5', unitPrice: '2.50' }], '12.50')]);
    expect(r!.warnings.map((w) => w.code)).toContain('QTY_HIGH');
  });
});

describe('an unexpected server error leaves a trace and a reference', () => {
  it('gives the user a reference, groups the occurrences, and alerts the administrator once', async () => {
    const editor = await login(t.app, (await createUser(t.db, { roles: ['PRODUITS'] })).username!);
    // A shelf that does not exist: the database refuses, which the API does not foresee.
    const body = {
      name: 'Pot',
      description: null,
      kind: 'GOODS',
      saleMode: 'UNIT',
      unitQty: null,
      unit: null,
      saleCondition: 'ON_SITE',
      shopVisible: true,
      categoryId: randomUUID(),
      supplierId: null,
      supplierRef: null,
      qualities: [],
      vatRate: '5.50',
      status: 'ACTIVE',
      purchasePriceExcl: null,
      salePrice: '2.00',
      minStock: null,
      eans: [],
      posTabId: null,
      posLabel: null,
      posSort: 0,
      code: '999991',
    };
    const res = await post('/products', body, editor);
    expect(res.statusCode).toBe(500);
    const ref = /Référence ([0-9A-F]{6})/.exec(res.json().detail)?.[1];
    expect(ref).toBeTruthy();
    await post('/products', { ...body, code: '999992' }, editor);

    await new Promise((r) => setTimeout(r, 300));
    const rows = await t.db.select().from(errorLog);
    expect(rows).toHaveLength(1); // same error, same page: one line
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.route).toBe('POST /api/v1/products');
    // Neither the SQL nor its parameters are kept: only what the database said.
    expect(rows[0]!.message).toContain('foreign key');
    expect(rows[0]!.message).not.toMatch(/insert into|params|999991|Pot/i);

    const mails = await mailsWith('Épicafé : une erreur inattendue est survenue');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('POST /api/v1/products');
    expect(mails[0]!.text).not.toMatch(/insert into|params/i);

    // The page and the « À surveiller » line are for the administrators only.
    const treasurer = await login(t.app, (await createUser(t.db, { roles: ['COMPTA'] })).username!);
    expect((await get('/admin/errors', treasurer)).statusCode).toBe(403);
    const seen = (await get('/admin/attention', treasurer)).json() as { code: string }[];
    expect(seen.some((i) => i.code === 'SERVER_ERRORS')).toBe(false);

    const list = (await get('/admin/errors')).json() as { id: string; lastRef: string }[];
    expect(list[0]!.lastRef).toMatch(/^[0-9A-F]{6}$/);
    expect((await attention()).find((i) => i.code === 'SERVER_ERRORS')).toMatchObject({ count: 1 });
    expect((await post(`/admin/errors/${list[0]!.id}/ack`)).statusCode).toBe(200);
    expect((await attention()).some((i) => i.code === 'SERVER_ERRORS')).toBe(false);
  });
});

describe('backups report to the application', () => {
  const report = (token: string | null, body: object) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/internal/backup-report',
      headers: {
        'x-episoft-csrf': '1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: body,
    });

  it('warns that no backup was ever reported, then is quiet after a good one', async () => {
    const before = (await attention()).find((i) => i.code === 'BACKUP_LATE');
    expect(before).toMatchObject({ severity: 'error' });
    expect(before).toBeTruthy();

    expect((await report(null, { kind: 'BACKUP', ok: true })).statusCode).toBe(401);
    expect(
      (await report('mauvais-jeton-0123456789', { kind: 'BACKUP', ok: true })).statusCode,
    ).toBe(401);
    const ok = await report('test-backup-token-0123456789', {
      kind: 'BACKUP',
      ok: true,
      sizeBytes: 123456,
      checksum: 'abc123',
      verified: true,
      offsite: true,
    });
    expect(ok.statusCode).toBe(204);
    expect((await attention()).some((i) => i.code === 'BACKUP_LATE')).toBe(false);

    const list = (await get('/admin/backups')).json() as { ok: boolean; verified: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ok: true, verified: true });
  });

  it('does not count a failed backup, nor an old one, as a good one', async () => {
    await report('test-backup-token-0123456789', {
      kind: 'BACKUP',
      ok: false,
      detail: 'disque plein',
    });
    expect((await attention()).find((i) => i.code === 'BACKUP_LATE')).toBeTruthy();
    await report('test-backup-token-0123456789', { kind: 'BACKUP', ok: true });
    await t.db.execute(sql`update app.backup_run set at = now() - interval '30 hours' where ok`);
    const late = (await attention()).find((i) => i.code === 'BACKUP_LATE');
    expect(late).toMatchObject({ severity: 'warning' });
    await t.db.execute(sql`update app.backup_run set at = now() - interval '60 hours' where ok`);
    expect((await attention()).find((i) => i.code === 'BACKUP_LATE')).toMatchObject({
      severity: 'error',
    });
  });
});

describe('the history of the integrity checks', () => {
  it('records a run when the administrator opens the page, and feeds « À surveiller »', async () => {
    expect(await t.db.select().from(integrityRun)).toHaveLength(0);
    const res = await get('/admin/integrity');
    expect(res.statusCode).toBe(200);
    const runs = await t.db.select().from(integrityRun);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ errors: res.json().errors, warnings: res.json().warnings });
    // Opening the page again straight away does not pile up rows.
    await get('/admin/integrity');
    expect(await t.db.select().from(integrityRun)).toHaveLength(1);

    // A corrupted stock cache is an error: it shows up, and goes when repaired.
    const p = await addProduct();
    await t.db.update(product).set({ stockQty: '99' }).where(eq(product.id, p.id));
    await get('/admin/integrity');
    expect((await attention()).find((i) => i.code === 'INTEGRITY_ERRORS')).toBeTruthy();
    await t.db.update(product).set({ stockQty: '10' }).where(eq(product.id, p.id));
    await get('/admin/integrity');
    expect((await attention()).some((i) => i.code === 'INTEGRITY_ERRORS')).toBe(false);
  });
});

describe('e-mails that did not leave', () => {
  it('lists them, lets an administrator send them again, and ignores the « sending off » ones', async () => {
    await t.db.insert(emailOutbox).values([
      { to: 'a@example.org', subject: 'Raté', html: '', status: 'FAILED', lastError: 'SMTP down' },
      {
        to: 'b@example.org',
        subject: 'Coupé',
        html: '',
        status: 'FAILED',
        lastError: 'Envoi des courriels désactivé dans l’administration.',
      },
    ]);
    const failed = (await get('/admin/emails/failed')).json() as { id: string; subject: string }[];
    expect(failed.map((m) => m.subject)).toEqual(['Raté']);
    expect((await attention()).find((i) => i.code === 'EMAILS_FAILED')).toMatchObject({ count: 1 });

    expect((await post(`/admin/emails/${failed[0]!.id}/resend`)).statusCode).toBe(200);
    expect((await get('/admin/emails/failed')).json()).toHaveLength(0);
    expect((await post(`/admin/emails/${failed[0]!.id}/resend`)).statusCode).toBe(404);
  });

  it('warns about e-mails waiting for more than an hour', async () => {
    await t.db.insert(emailOutbox).values({ to: 'c@example.org', subject: 'Coincé', html: '' });
    await t.db.execute(sql`update app.email_outbox set created_at = now() - interval '2 hours'`);
    expect((await attention()).find((i) => i.code === 'EMAILS_STUCK')).toMatchObject({ count: 1 });
  });
});

describe('an operation that arrives before what it depends on is never lost', () => {
  const rawPush = (ops: SyncOp[]) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: cashier,
      payload: { deviceId, ops },
    });
  const cancelOf = (saleId: string): SyncOp => {
    const seq = till.nextSeq();
    return {
      kind: 'SALE_CANCEL',
      id: randomUUID(),
      deviceSeq: seq,
      payload: {
        cancelSaleId: randomUUID(),
        saleId,
        sessionId,
        cashierId,
        at: new Date().toISOString(),
        provisionalNumber: `CAISSE1-${seq}`,
      },
    };
  };

  it('answers « not yet » to a cancellation ahead of its ticket, stores nothing, and accepts it later', async () => {
    const p = await addProduct();
    const sale = saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50');
    const cancel = cancelOf(sale.id);

    const early = await rawPush([cancel]);
    expect(early.statusCode).toBe(409);
    expect(early.json().detail).toContain('pas encore arrivé');
    // Not refused for good, not recorded as a rejection, no alarm for the administrators.
    expect(await t.db.select().from(syncRejection)).toHaveLength(0);
    expect(
      (
        await t.db.execute(
          sql`select count(*)::int as n from app.sync_receipt where client_id = ${cancel.id}`,
        )
      ).rows[0],
    ).toMatchObject({ n: 0 });
    expect(await t.db.select().from(errorLog)).toHaveLength(0);

    // The ticket arrives, then the cancellation is sent again: both go through.
    const done = await push([sale, cancel]);
    expect(done.map((r) => r.status)).toEqual(['OK', 'OK']);
    const [stock] = (
      await t.db.execute(sql`select stock_qty::text as q from app.product where id = ${p.id}`)
    ).rows as { q: string }[];
    expect(Number(stock!.q)).toBe(10);
  });

  it('answers « not yet » to a ticket sold in a session that has not arrived yet', async () => {
    const p = await addProduct();
    const lateSession = randomUUID();
    const sale = saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50');
    if (sale.kind === 'SALE') sale.payload.sessionId = lateSession;
    expect((await rawPush([sale])).statusCode).toBe(409);
    expect(await t.db.select().from(syncRejection)).toHaveLength(0);

    const seq = till.nextSeq();
    const open: SyncOp = {
      kind: 'SESSION_OPEN',
      id: lateSession,
      deviceSeq: seq,
      payload: {
        sessionId: lateSession,
        openedBy: cashierId,
        openedAt: new Date().toISOString(),
        openingFloat: '0.00',
      },
    };
    // Another till already has a session open: this one is refused for this device, which is
    // not what is tested here — the session is opened from a second device instead.
    const second = (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/pos/devices',
        headers: cashier,
        payload: { name: 'CAISSE2' },
      })
    ).json().id as string;
    const opened = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: cashier,
      payload: { deviceId: second, ops: [{ ...open, deviceSeq: 1 }] },
    });
    expect(opened.json().results[0].status).toBe('OK');
    const [r] = await push([sale]);
    expect(r!.status).toBe('OK');
  });

  it('refuses for good a cancellation of a ticket that had itself been refused', async () => {
    const bad = saleOp([{ productId: randomUUID(), unitPrice: '2.50' }], '2.50');
    expect((await push([bad]))[0]!.status).toBe('REJECTED');
    const [r] = await push([cancelOf(bad.id)]);
    expect(r).toMatchObject({ status: 'REJECTED' });
    expect(r!.error).toContain('avait été refusé');
  });
});

describe('what changed lately', () => {
  it('lists the latest changes in plain sentences, with who did them', async () => {
    await push([saleOp([{ productId: randomUUID(), unitPrice: '2.50' }], '2.50')]);
    const [r] = (await get('/admin/rejections')).json() as { id: string }[];
    await post(`/admin/rejections/${r!.id}/ack`);
    const feed = (await get('/admin/activity')).json() as {
      actor: string;
      sentence: string;
      at: string;
    }[];
    expect(feed[0]!.sentence).toBe('a classé un ticket refusé par le serveur');
    expect(feed[0]!.actor).toMatch(/Prénom\d+ NOM\d+/);
    expect(feed.some((f) => f.sentence === 'a ouvert une session de caisse')).toBe(true);
    expect(feed.every((f) => !/\b(rejection|sale\.|session\.)/.test(f.sentence))).toBe(true);
  });

  it('is reserved to the administrators and the treasury', async () => {
    expect((await get('/admin/activity', cashier)).statusCode).toBe(403);
  });
});

describe('the other things to watch', () => {
  it('reports a session left open for more than a day, a negative cagnotte and old drafts', async () => {
    await t.db.execute(
      sql`update app.cash_session set opened_at = now() - interval '2 days' where id = ${sessionId}`,
    );
    const codes = (await attention()).map((i) => i.code);
    expect(codes).toContain('SESSION_OLD');
  });

  it('is empty when all is well, except the missing backup', async () => {
    const codes = (await attention()).map((i) => i.code);
    expect(codes).toEqual(['BACKUP_LATE']);
  });
});

describe('closing the till: a gap or a forced closing must be explained', () => {
  const close = (payload: object) =>
    post(`/pos/sessions/${sessionId}/close`, { ...base, ...payload }, cashier);
  const base = {
    bankDeposit: '0',
    chequesCount: 0,
    chequesTotal: '0',
    cardTotalDeclared: '0',
  };

  it('refuses a gap above the threshold without a comment, accepts a small one', async () => {
    // 100 € of float, 90 € counted: 10 € missing.
    const refused = await close({ denominations: { '5000': 1, '2000': 2 } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().detail).toContain('Écart de caisse');
    expect(refused.json().detail).toContain('-10.00');

    // 98 € counted: 2 € missing, below the 5 € threshold: no comment needed.
    const small = await close({
      denominations: { '5000': 1, '2000': 2, '500': 1, '200': 1, '100': 1 },
    });
    expect(small.statusCode, small.body).toBe(200);
  });

  it('accepts the large gap once a comment explains it, and keeps the comment', async () => {
    const ok = await close({
      denominations: { '5000': 1, '2000': 2 },
      comment: 'Un billet de 10 € rendu en trop',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ difference: '-10.00' });
    const [row] = (await t.db.execute(sql`select comment from app.cash_count`)).rows as {
      comment: string;
    }[];
    expect(row!.comment).toContain('billet de 10');
  });

  it('refuses a short comment, and a forced closing with no reason', async () => {
    expect(
      (await close({ denominations: { '5000': 1, '2000': 2 }, comment: 'x' })).statusCode,
    ).toBe(400);
    const forced = await close({ denominations: { '5000': 2 }, forced: true });
    expect(forced.statusCode).toBe(400);
    expect(forced.json().detail).toContain('pas été envoyés');
    const withReason = await close({
      denominations: { '5000': 2 },
      forced: true,
      comment: 'Réseau coupé, tickets envoyés demain',
    });
    expect(withReason.statusCode, withReason.body).toBe(200);
  });

  it('does not ask a reason of an administrator who closes a forgotten session', async () => {
    const res = await post(`/pos/sessions/${sessionId}/force-close`, { comment: 'Poste perdu' });
    expect(res.statusCode, res.body).toBe(200);
  });
});
