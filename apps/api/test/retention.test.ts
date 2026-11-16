import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { household, member, setting, walletEntry, type Tx } from '@episoft/db';
import { DEFAULT_RETENTION, retentionSchema, type RetentionSettings } from '@episoft/shared';
import { auditSystem } from '../src/lib/audit';
import { runNightlyRetention } from '../src/modules/admin/retention/job';
import { buildPlan, planByClass, runPurge } from '../src/modules/admin/retention/engine';
import { anonymizeInactive, inactiveMembers } from '../src/modules/admin/retention/inactive-members';
import { diskSpace, weeklySnapshot } from '../src/modules/admin/retention/size';
import { createUser, login, refusedToAppRole, setupTestApp } from './helpers';

// ADR 0017: the retention policy. The purge removes only what the policy allows, never below a
// legal floor, never a history table; what the dry run counts is what the purge removes.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let dir: string;
beforeAll(async () => {
  t = await setupTestApp();
  dir = mkdtempSync(join(tmpdir(), 'episoft-archives-'));
  t.config.ARCHIVE_DIR = dir;
});
afterAll(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await t.reset();
  await t.db.execute(
    sql`truncate app.error_log, app.job_run, app.till_pin_attempt, app.integrity_run, app.backup_run,
        app.price_history, app.feedback_comment, app.feedback_ticket, app.sync_rejection, app.db_size_snapshot`,
  );
});

const NOW = new Date();
const monthsAgo = (m: number) => {
  const d = new Date(NOW);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString();
};
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const cfg = (patch: Partial<RetentionSettings> = {}): RetentionSettings =>
  retentionSchema.parse({ ...DEFAULT_RETENTION, ...patch });

const record = (tx: Tx, s: unknown) =>
  auditSystem(tx, { action: 'retention.purge', entity: 'retention', after: s });
const purge = (settings = cfg(), opts: Record<string, unknown> = {}) =>
  runPurge(t.jobsDb, settings, NOW, {
    archive: false,
    archiveDir: dir,
    trigger: 'manual',
    record: (tx, s) => record(tx, s),
    pauseMs: 0,
    ...opts,
  });

const count = async (table: string, where = 'true') =>
  Number(
    (await t.db.execute<{ n: string }>(sql.raw(`select count(*) as n from app.${table} where ${where}`)))
      .rows[0]!.n,
  );

/** A row of the journal at a given age (the table is append-only: only the superuser inserts). */
async function journal(action: string, at: string, n = 1) {
  for (let i = 0; i < n; i++)
    await t.db.execute(sql`insert into app.audit_log (id, at, action, entity) values (gen_random_uuid(), ${at}::timestamptz, ${action}, 'x')`);
}
async function change(table: string, at: string, n = 1) {
  for (let i = 0; i < n; i++)
    await t.db.execute(
      sql`insert into app.data_change (at, table_name, op, source) values (${at}::timestamptz, ${table}, 'I', 'test')`,
    );
}

describe('legal floors: what the purge keeps, whatever the age', () => {
  it('keeps the journals of legal data until their floor, and purges the others by their own duration', async () => {
    // Defaults: accounting 120 months, tickets 72, security 60, other 36.
    await journal('entry.validate', monthsAgo(100)); // accounting, under 10 years: kept
    await journal('entry.validate', monthsAgo(130)); // accounting, over 10 years: goes
    await journal('sale.create', monthsAgo(60)); // tickets, under 6 years: kept
    await journal('sale.create', monthsAgo(80)); // tickets, over 6 years: goes
    await journal('auth.login', monthsAgo(70)); // security, over 5 years: goes
    await journal('auth.login', monthsAgo(40)); // kept
    await journal('product.update', monthsAgo(40)); // other, over 3 years: goes
    await journal('product.update', monthsAgo(20)); // kept
    await change('entry_line', monthsAgo(100)); // accounting: kept
    await change('sale_line', monthsAgo(60)); // tickets: kept
    await change('sale_line', monthsAgo(80)); // goes
    await change('product', monthsAgo(30)); // other, over 24 months: goes
    await change('product', monthsAgo(10)); // kept
    const s = await purge();
    expect(s.error).toBeNull();
    expect(await count('audit_log', `action = 'entry.validate'`)).toBe(1);
    expect(await count('audit_log', `action = 'sale.create'`)).toBe(1);
    expect(await count('audit_log', `action = 'auth.login'`)).toBe(1);
    expect(await count('audit_log', `action = 'product.update'`)).toBe(1);
    expect(await count('data_change', `table_name = 'entry_line'`)).toBe(1);
    expect(await count('data_change', `table_name = 'sale_line'`)).toBe(1);
    expect(await count('data_change', `table_name = 'product' and at < now() - interval '20 months'`)).toBe(0);
    // Four journal rows and two changes of the test fixtures are gone, nothing else.
    expect(s.classes.find((c) => c.classId === 'audit_accounting')!.rows).toBe(1);
    expect(s.classes.find((c) => c.classId === 'data_change_sales')!.rows).toBe(1);
  });

  it('a setting under a floor is refused by the API, quoting the rule; the legal records are not a class', async () => {
    const a = await createUser(t.db, { roles: ['ADMIN'] });
    const headers = await login(t.app, a.username!);
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/data.retention',
      headers,
      payload: { ...DEFAULT_RETENTION, durations: { ...DEFAULT_RETENTION.durations, audit_accounting: 24 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0].path).toBe('durations.audit_accounting');
    expect(bad.json().errors[0].message).toContain('L123-22');
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/data.retention',
      headers,
      payload: { ...DEFAULT_RETENTION, durations: { ...DEFAULT_RETENTION.durations, audit_other: 12 } },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('the application role cannot delete the journals or the history by itself, nor purge a history table', async () => {
    expect(await refusedToAppRole(sql`delete from app.audit_log`)).toBe('42501');
    expect(await refusedToAppRole(sql`delete from app.data_change`)).toBe('42501');
    // Turning the flag on is not enough: the role does not own the table.
    expect(
      await refusedToAppRole(sql`select set_config('episoft.purge', 'on', true)`, sql`delete from app.audit_log`),
    ).toBe('42501');
    // The function takes a closed list of kinds.
    for (const kind of ['sale', 'sale_line', 'entry', 'wallet_entry', 'stock_movement', 'member', 'x; drop table app.sale'])
      expect(
        await refusedToAppRole(sql`select * from app.retention_run(${kind}, now(), 10, 'purge', '{}')`),
      ).toBe('P0001');
  });
});

describe('dry run, batches, archive, journal entry', () => {
  async function seedTechnical() {
    const [p] = await t.db.execute<{ id: string }>(
      sql`insert into app.product (id, code, name, sale_price) values (gen_random_uuid(), ${'RET' + Math.random().toString(36).slice(2, 8)}, 'Pain', 1) returning id`,
    ).then((r) => r.rows);
    const m = await createUser(t.db, { roles: [] });
    for (let i = 0; i < 25; i++)
      await t.db.execute(sql`insert into app.job_run (name, day) values (${'j' + i}, (${monthsAgo(6)}::timestamptz)::date)`);
    await t.db.execute(sql`insert into app.job_run (name, day) values ('recent', current_date)`);
    await t.db.execute(sql`insert into app.error_log (id, fingerprint, message, last_at, last_ref) values (gen_random_uuid(), 'a', 'old', ${monthsAgo(14)}::timestamptz, 'r1'), (gen_random_uuid(), 'b', 'new', now(), 'r2')`);
    await t.db.execute(sql`insert into app.login_log (id, member_id, at, success) values (gen_random_uuid(), ${m.id}, ${monthsAgo(14)}::timestamptz, true), (gen_random_uuid(), ${m.id}, now(), true)`);
    await t.db.execute(sql`insert into app.session (id, member_id, expires_at) values ('s-old', ${m.id}, ${daysAgo(60)}::timestamptz), ('s-new', ${m.id}, ${daysAgo(-1)}::timestamptz)`);
    await t.db.execute(sql`insert into app.integrity_run (id, at, errors, warnings, duration_ms, failing) values (gen_random_uuid(), ${monthsAgo(15)}::timestamptz, 0, 0, 1, '{}'), (gen_random_uuid(), ${monthsAgo(14)}::timestamptz, 0, 0, 1, '{}')`);
    await t.db.execute(sql`insert into app.price_history (id, product_id, at, sale_price, source) values (gen_random_uuid(), ${p!.id}, ${monthsAgo(70)}::timestamptz, 1, 'FORM'), (gen_random_uuid(), ${p!.id}, ${monthsAgo(65)}::timestamptz, 1.2, 'FORM')`);
    await t.db.execute(sql`insert into app.email_outbox (id, "to", subject, html, text, status, created_at, sent_at) values
      (gen_random_uuid(), 'a@x.org', 'old sent', '<p>secret</p>', 'secret', 'SENT', ${daysAgo(120)}::timestamptz, ${daysAgo(120)}::timestamptz),
      (gen_random_uuid(), 'b@x.org', 'recent sent', '<p>hello</p>', 'hello', 'SENT', ${daysAgo(5)}::timestamptz, ${daysAgo(5)}::timestamptz),
      (gen_random_uuid(), 'c@x.org', 'old failed', '<p>fail</p>', 'fail', 'FAILED', ${daysAgo(120)}::timestamptz, null),
      (gen_random_uuid(), 'd@x.org', 'old pending', '<p>wait</p>', 'wait', 'PENDING', ${daysAgo(900)}::timestamptz, null),
      (gen_random_uuid(), 'e@x.org', 'very old sent', '<p>old</p>', 'old', 'SENT', ${monthsAgo(30)}::timestamptz, ${monthsAgo(30)}::timestamptz)`);
    await t.db.execute(sql`insert into app.feedback_ticket (id, number, kind, module, title, description, status, closed_at)
      values (gen_random_uuid(), 1, 'BUG', 'caisse', 'old closed', 'd', 'DONE', ${monthsAgo(30)}::timestamptz),
             (gen_random_uuid(), 2, 'BUG', 'caisse', 'old open', 'd', 'NEW', null)`);
    await t.db.execute(sql`insert into app.feedback_comment (id, ticket_id, body) select gen_random_uuid(), id, 'hi' from app.feedback_ticket where number = 1`);
  }

  it('the dry run counts exactly what the purge removes, per class', async () => {
    await seedTechnical();
    await journal('product.update', monthsAgo(40), 3);
    await change('product', monthsAgo(30), 4);
    const plan = planByClass(await buildPlan(t.jobsDb, cfg(), NOW));
    const planned = Object.fromEntries(plan.map((c) => [c.classId, c.rows]));
    expect(planned.job_run).toBe(25);
    expect(planned.error_log).toBe(1);
    expect(planned.login_log).toBe(1);
    expect(planned.expired_sessions).toBe(1);
    expect(planned.integrity_run).toBe(1); // the latest run stays
    expect(planned.price_history).toBe(1); // the latest price stays
    expect(planned.email_body).toBe(2);
    expect(planned.email_rows).toBe(1); // a pending one is never removed
    expect(planned.feedback).toBe(1); // the closed ticket (its comment goes with it, the open one stays)
    const s = await purge();
    expect(s.error).toBeNull();
    for (const c of s.classes) expect(c.rows, c.classId).toBe(planned[c.classId]);
    expect(s.total).toBe(plan.reduce((a, c) => a + c.rows, 0));
    expect(await count('job_run')).toBe(1);
    expect(await count('error_log')).toBe(1);
    expect(await count('session', `id = 's-old'`)).toBe(0);
    expect(await count('session', `id = 's-new'`)).toBe(1);
    expect(await count('integrity_run')).toBe(1);
    expect(await count('price_history')).toBe(1);
    // A second purge finds nothing (the same predicate).
    const again = planByClass(await buildPlan(t.jobsDb, cfg(), NOW));
    expect(again.reduce((a, c) => a + c.rows, 0)).toBe(0);
  });

  it('keeps the line of an e-mail whose content is purged, and never touches a pending or failed one', async () => {
    await seedTechnical();
    await purge(cfg(), { classIds: ['email_body'] });
    const { rows } = await t.db.execute<{ subject: string; html: string; text: string | null }>(
      sql`select subject, html, text from app.email_outbox order by subject`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.subject, r]));
    expect(by['old sent']!.html).toContain('supprimé');
    expect(by['old sent']!.text).toBeNull();
    expect(by['recent sent']!.html).toBe('<p>hello</p>');
    expect(by['old failed']!.html).toBe('<p>fail</p>');
    expect(by['old pending']!.html).toBe('<p>wait</p>');
    // Rows of the journal of e-mails: only the old ones that left.
    await purge(cfg(), { classIds: ['email_rows'] });
    expect(await count('email_outbox', `subject = 'very old sent'`)).toBe(0);
    expect(await count('email_outbox', `subject = 'old pending'`)).toBe(1);
  });

  it('works in small batches, each its own transaction', async () => {
    await seedTechnical();
    const progress: number[] = [];
    const s = await purge(cfg(), { classIds: ['job_run'], batchSize: 10, onProgress: (_c: string, n: number) => progress.push(n) });
    expect(s.total).toBe(25);
    expect(progress).toEqual([10, 20, 25]);
    expect(await count('job_run')).toBe(1);
  });

  it('stops at its time limit and says so, the rest goes next time', async () => {
    await seedTechnical();
    const s = await purge(cfg(), { classIds: ['job_run'], batchSize: 5, maxMs: 1, pauseMs: 30 });
    expect(s.truncated).toBe(true);
    expect(await count('job_run')).toBeGreaterThan(1);
    const rest = await purge(cfg(), { classIds: ['job_run'] });
    expect(rest.truncated).toBe(false);
    expect(await count('job_run')).toBe(1);
  });

  it('writes one summary row in the journal, and no row per purged line in the record of changes', async () => {
    await seedTechnical();
    await journal('product.update', monthsAgo(40), 5);
    const before = await count('data_change');
    const s = await purge();
    expect(s.total).toBeGreaterThan(30);
    const rows = await t.db.execute<{ after: { total: number; classes: unknown[]; trigger: string } }>(
      sql`select after from app.audit_log where action = 'retention.purge'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.after.total).toBe(s.total);
    expect(rows.rows[0]!.after.trigger).toBe('manual');
    // Nothing of what was purged is copied into data_change (only the summary row's own capture,
    // and the snapshot, are new).
    expect(before).toBeGreaterThan(0);
    expect(
      await count(
        'data_change',
        `table_name in ('job_run', 'error_log', 'login_log', 'session', 'price_history', 'email_outbox', 'feedback_ticket') and op in ('D', 'U')`,
      ),
    ).toBe(0);
    expect(await count('db_size_snapshot', `reason = 'after_purge'`)).toBe(1);
  });

  it('archives what it removes into a compressed file, secrets of sessions excepted', async () => {
    await seedTechnical();
    const s = await purge(cfg(), { archive: true, classIds: ['error_log', 'expired_sessions', 'feedback'] });
    expect(s.archiveFile).toMatch(/^purge-\d{8}-\d{6}-manual\.jsonl\.gz$/);
    const path = join(dir, s.archiveFile!);
    expect(existsSync(path)).toBe(true);
    const lines = gunzipSync(readFileSync(path)).toString().trim().split('\n').map((l) => JSON.parse(l));
    const tables = lines.map((l) => l.table).sort();
    expect(tables).toEqual(['error_log', 'feedback_comment', 'feedback_ticket']);
    expect(lines.find((l) => l.table === 'error_log').row.message).toBe('old');
    expect(await count('session', `id = 's-old'`)).toBe(0);
  });
});

describe('nightly job', () => {
  it('does nothing until it is turned on, then runs once a day and a weekly size snapshot is kept', async () => {
    await t.db.execute(sql`insert into app.job_run (name, day) values ('old', current_date - 400)`);
    expect(await runNightlyRetention(t.jobsDb, { ...t.config, ARCHIVE_DIR: dir }, NOW)).toBe(0);
    expect(await count('job_run', `name = 'old'`)).toBe(1);
    expect(await count('db_size_snapshot', `reason = 'weekly'`)).toBe(1);
    await t.db.insert(setting).values({ key: 'data.retention', value: { ...DEFAULT_RETENTION, nightly: true } });
    expect(await runNightlyRetention(t.jobsDb, { ...t.config, ARCHIVE_DIR: dir }, NOW)).toBeGreaterThan(0);
    expect(await count('job_run', `name = 'old'`)).toBe(0);
    expect(await runNightlyRetention(t.jobsDb, { ...t.config, ARCHIVE_DIR: dir }, NOW)).toBeNull();
    const nightly = await t.db.execute<{ after: { trigger: string } }>(sql`select after from app.audit_log where action = 'retention.purge'`);
    expect(nightly.rows[0]!.after.trigger).toBe('nightly');
    // The snapshot of the week is taken once.
    expect(await weeklySnapshot(t.jobsDb, NOW)).toBe(false);
  });
});

describe('inactive members (spec Q8)', () => {
  async function old(m: { id: string }, years = 5) {
    await t.db.execute(
      sql`update app.member set created_at = now() - make_interval(years => ${years}) where id = ${m.id}`,
    );
  }
  const record2 = (tx: Tx, m: { id: string }) =>
    auditSystem(tx, { action: 'member.anonymize', entity: 'member', entityId: m.id, after: { automatic: true } });

  it('anonymises the inactive, and spares the active, the creditors, the staff and the open orders', async () => {
    const plain = await createUser(t.db, { roles: [], status: 'INACTIVE' });
    const creditor = await createUser(t.db, { roles: [] });
    const staff = await createUser(t.db, { roles: ['CAISSE'] });
    const orderer = await createUser(t.db, { roles: [] });
    const recent = await createUser(t.db, { roles: [] });
    const shared = await createUser(t.db, { roles: [] });
    const sharedPartner = await createUser(t.db, { roles: [] });
    for (const m of [plain, creditor, staff, orderer, recent, shared, sharedPartner]) await old(m);
    await t.db.execute(sql`update app.member set created_at = now() where id = ${recent.id}`);

    const [hCreditor] = await t.db.insert(household).values({}).returning();
    await t.db.update(member).set({ householdId: hCreditor!.id }).where(sql`id = ${creditor.id}`);
    await t.db.insert(walletEntry).values({ householdId: hCreditor!.id, amount: '12.00', kind: 'TOPUP', at: new Date(Date.now() - 5 * 365 * 86_400_000) });

    const [hOrder] = await t.db.insert(household).values({}).returning();
    await t.db.update(member).set({ householdId: hOrder!.id }).where(sql`id = ${orderer.id}`);
    await t.db.execute(sql`insert into app.preorder (id, number, member_id, household_id, status, pickup_date, created_at)
      values (gen_random_uuid(), 'P-RET', ${orderer.id}, ${hOrder!.id}, 'SUBMITTED', current_date, now() - interval '5 years')`);

    // Two members of one household: one of them signed in last week, so neither is inactive.
    const [hShared] = await t.db.insert(household).values({}).returning();
    await t.db.update(member).set({ householdId: hShared!.id }).where(sql`id in (${shared.id}, ${sharedPartner.id})`);
    await t.db.execute(sql`insert into app.login_log (id, member_id, at, success) values (gen_random_uuid(), ${sharedPartner.id}, now() - interval '3 days', true)`);

    const report = await inactiveMembers(t.jobsDb, 3, NOW);
    expect(report.candidates.map((c) => c.id)).toEqual([plain.id]);
    const why = Object.fromEntries(report.excluded.map((r) => [r.id, r.excluded]));
    expect(why[creditor.id]).toEqual(['BALANCE']);
    expect(why[staff.id]).toEqual(['ROLE']);
    expect(why[orderer.id]).toEqual(['OPEN_PREORDER']);
    expect(report.excluded.map((r) => r.id)).not.toContain(recent.id);
    expect(report.excluded.map((r) => r.id)).not.toContain(shared.id);

    expect(await anonymizeInactive(t.jobsDb, 3, NOW, record2)).toBe(1);
    const rows = await t.db.select().from(member);
    const get = (id: string) => rows.find((r) => r.id === id)!;
    expect(get(plain.id)).toMatchObject({ firstName: '-', status: 'ARCHIVED', email: null, passwordHash: null });
    expect(get(plain.id).lastName).toMatch(/^Membre #\d+$/);
    for (const m of [creditor, staff, orderer, recent, shared, sharedPartner])
      expect(get(m.id).email, m.id).toBe(m.email);
    // Done once: the member is not a candidate any more.
    expect((await inactiveMembers(t.jobsDb, 3, NOW)).candidates).toHaveLength(0);
    expect(await count('audit_log', `action = 'member.anonymize'`)).toBe(1);
  });

  it('an id that is not a candidate is never forced, through the API either', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const staff = await createUser(t.db, { roles: ['CAISSE'] });
    const plain = await createUser(t.db, { roles: [] });
    await old(staff);
    await old(plain);
    await t.db.execute(sql`update app.member set created_at = now() where id = ${admin.id}`);
    const headers = await login(t.app, admin.username!);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/retention/anonymize',
      headers,
      payload: { confirm: true, ids: [staff.id, plain.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ anonymized: 1 });
    const none = await t.app.inject({ method: 'POST', url: '/api/v1/admin/retention/anonymize', headers, payload: { ids: [] } });
    expect(none.statusCode).toBe(400); // no confirmation
    const list = await t.app.inject({ url: '/api/v1/admin/retention/inactive-members', headers });
    expect(list.json().candidates).toEqual([]);
    expect(list.json().excluded[0].reasons).toEqual(['A un rôle dans l’application']);
  });
});

describe('administration routes', () => {
  it('previews, purges in the background with a confirmation, lists and downloads the archive, and shows the sizes', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const other = await createUser(t.db, { roles: ['COMPTA'] });
    const headers = await login(t.app, admin.username!);
    const cashierHeaders = await login(t.app, other.username!);
    await t.db.execute(sql`insert into app.error_log (id, fingerprint, message, last_at, last_ref) values (gen_random_uuid(), 'z', 'old', now() - interval '20 months', 'r')`);
    // Not for anyone else.
    for (const url of ['/api/v1/admin/retention/preview', '/api/v1/admin/database'])
      expect((await t.app.inject({ url, headers: cashierHeaders })).statusCode).toBe(403);

    const prev = await t.app.inject({ url: '/api/v1/admin/retention/preview', headers });
    expect(prev.statusCode).toBe(200);
    expect(prev.json().classes.find((c: { classId: string }) => c.classId === 'error_log').rows).toBe(1);
    expect(await count('error_log', `fingerprint = 'z'`)).toBe(1); // a preview changes nothing

    const unconfirmed = await t.app.inject({ method: 'POST', url: '/api/v1/admin/retention/purge', headers, payload: {} });
    expect(unconfirmed.statusCode).toBe(400);
    expect(await count('error_log', `fingerprint = 'z'`)).toBe(1);

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/retention/purge',
      headers,
      payload: { confirm: true, archive: true, classIds: ['error_log'] },
    });
    expect(started.statusCode).toBe(202);
    await expect
      .poll(async () => (await t.app.inject({ url: '/api/v1/admin/retention/status', headers })).json().last?.total, { timeout: 15000 })
      .toBe(1);
    expect(await count('error_log', `fingerprint = 'z'`)).toBe(0);
    const entry = await t.db.execute<{ actor_id: string; after: { archiveFile: string } }>(sql`select actor_id, after from app.audit_log where action = 'retention.purge'`);
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]!.actor_id).toBe(admin.id);

    const list = (await t.app.inject({ url: '/api/v1/admin/retention/archives', headers })).json();
    expect(list.files).toHaveLength(1);
    const name = list.files[0].name;
    const dl = await t.app.inject({ url: `/api/v1/admin/retention/archives/${name}`, headers });
    expect(dl.statusCode).toBe(200);
    expect(gunzipSync(dl.rawPayload).toString()).toContain('"table":"error_log"');
    expect((await t.app.inject({ url: '/api/v1/admin/retention/archives/..%2Fx', headers })).statusCode).toBe(400);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/retention/archives/${name}`, headers });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/v1/admin/retention/archives', headers })).json().files).toHaveLength(0);
    expect(await count('audit_log', `action = 'retention.archive_delete'`)).toBe(1);
  });

  it('reports sizes, snapshots, the estimate of the purge and the alerts', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const headers = await login(t.app, admin.username!);
    await weeklySnapshot(t.jobsDb, NOW);
    const res = await t.app.inject({ url: '/api/v1/admin/database', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bytes).toBeGreaterThan(1_000_000);
    expect(body.tables.map((x: { name: string }) => x.name)).toContain('audit_log');
    expect(body.tables[0].totalBytes).toBeGreaterThanOrEqual(body.tables.at(-1).totalBytes);
    expect(body.snapshots).toHaveLength(1);
    expect(body.overThreshold).toBe(false);
    expect(body.estimate).toEqual({ rows: expect.any(Number), bytes: expect.any(Number) });
    if (body.disk) expect(body.diskLow).toBe(body.disk.freePct < 10);
  });

  it('puts the free disk space in « À surveiller » when it is under the threshold', async () => {
    const admin = await createUser(t.db, { roles: ['ADMIN'] });
    const headers = await login(t.app, admin.username!);
    const none = await t.app.inject({ url: '/api/v1/admin/attention', headers });
    expect(JSON.stringify(none.json())).not.toContain('DB_SIZE');
    // A disk is never 90 % free on a machine that runs the tests: the alert shows.
    await t.db.insert(setting).values({ key: 'data.retention', value: { ...DEFAULT_RETENTION, alerts: { dbSizeMb: 2048, diskFreePct: 90 } } });
    const res = await t.app.inject({ url: '/api/v1/admin/attention', headers });
    expect(res.statusCode).toBe(200);
    const disk = await diskSpace();
    if (disk && disk.freePct < 90) expect(JSON.stringify(res.json())).toContain('DISK_LOW');
  });
});
