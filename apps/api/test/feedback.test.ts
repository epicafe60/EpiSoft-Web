import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailOutbox, feedbackTicket } from '@episoft/db';
import { createUser, login, setupTestApp } from './helpers';

// Signalements: any signed-in person reports a bug or an idea; the author follows their own, the
// administrators handle all.

let t: Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;
let alice: Headers;
let bob: Headers;
let boss: Headers;
let aliceEmail: string;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(
    sql`truncate app.feedback_comment, app.feedback_ticket, app.number_counter cascade`,
  );
  const a = await createUser(t.db, { roles: [] });
  aliceEmail = a.email!;
  alice = await login(t.app, a.username!);
  bob = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
  boss = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
});

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Headers, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers, payload });

const bug = {
  kind: 'BUG',
  module: 'membres',
  screen: 'Fiche d’un adhérent',
  title: 'Le bouton Enregistrer ne répond pas',
  description: 'Rien ne se passe quand je clique sur Enregistrer.',
  steps: '1. Ouvrir une fiche\n2. Changer le téléphone\n3. Cliquer sur Enregistrer',
  context: { page: '/membres/12', userAgent: 'Test/1.0', viewport: '390x844' },
};

async function report(headers = alice, body: object = bug) {
  const res = await call('POST', '/feedback', headers, body);
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; number: string };
}

const mailsTo = async (to: string) =>
  (await t.db.select().from(emailOutbox)).filter((m) => m.to === to);

describe('creating a signalement', () => {
  it('lets any signed-in person report, with who and when filled in by the server', async () => {
    const r = await report();
    expect(r.number).toBe('SIG-0001');
    expect((await report(bob, { ...bug, title: 'Un autre problème' })).number).toBe('SIG-0002');
    const detail = (await call('GET', `/feedback/${r.id}`, alice)).json();
    expect(detail).toMatchObject({
      kind: 'BUG',
      module: 'membres',
      status: 'NEW',
      priority: 'NORMAL',
      steps: bug.steps,
      authorName: expect.stringContaining('Prénom'),
    });
    expect(detail.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The roles come from the session, not from the page.
    const [row] = await t.db.select().from(feedbackTicket).where(eq(feedbackTicket.id, r.id));
    expect(row!.context).toMatchObject({ page: '/membres/12', roles: [] });
  });

  it('asks for the steps of a bug, not of an idea, and refuses bad values', async () => {
    expect((await call('POST', '/feedback', alice, { ...bug, steps: '' })).statusCode).toBe(400);
    const idea = await call('POST', '/feedback', alice, {
      ...bug,
      kind: 'EVOLUTION',
      steps: '',
      title: 'Filtrer par commune',
    });
    expect(idea.statusCode).toBe(200);
    for (const bad of [{ module: 'inconnu' }, { title: 'abc' }, { kind: 'AUTRE' }])
      expect((await call('POST', '/feedback', alice, { ...bug, ...bad })).statusCode).toBe(400);
  });

  it('tells the administrators, and shows the report in « À surveiller »', async () => {
    await report();
    await expect
      .poll(async () => (await t.db.select().from(emailOutbox)).length, { timeout: 5000 })
      .toBeGreaterThan(0);
    const items = (await call('GET', '/admin/attention', boss)).json() as {
      code: string;
      count: number;
    }[];
    expect(items.find((i) => i.code === 'FEEDBACK_NEW')?.count).toBe(1);
  });

  it('is limited to a few reports a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++)
      codes.push(
        (await call('POST', '/feedback', alice, { ...bug, title: `Essai numéro ${i}` })).statusCode,
      );
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

describe('who sees what', () => {
  it('shows each person their own reports only, and everything to an administrator', async () => {
    const a = await report(alice);
    const b = await report(bob, { ...bug, title: 'Problème de Bob' });
    expect(
      (await call('GET', '/feedback/mine', alice)).json().map((r: { id: string }) => r.id),
    ).toEqual([a.id]);
    // Someone else's report is not found, not even confirmed to exist.
    expect((await call('GET', `/feedback/${b.id}`, alice)).statusCode).toBe(404);
    expect(
      (await call('POST', `/feedback/${b.id}/comments`, alice, { body: 'Bonjour' })).statusCode,
    ).toBe(404);
    expect((await call('GET', `/feedback/${b.id}`, boss)).statusCode).toBe(200);
    expect((await call('GET', '/feedback', boss)).json()).toHaveLength(2);
  });

  it('keeps the management of the reports for the administrators', async () => {
    const a = await report(alice);
    expect((await call('GET', '/feedback', alice)).statusCode).toBe(403);
    expect((await call('PATCH', `/feedback/${a.id}`, alice, { status: 'DONE' })).statusCode).toBe(
      403,
    );
    expect((await call('PATCH', `/feedback/${a.id}`, bob, { priority: 'HIGH' })).statusCode).toBe(
      403,
    );
  });

  it('filters and searches for an administrator', async () => {
    await report(alice);
    await report(bob, {
      ...bug,
      kind: 'EVOLUTION',
      module: 'compta',
      title: 'Export du grand livre',
      steps: '',
    });
    const list = async (qs: string) => (await call('GET', `/feedback?${qs}`, boss)).json();
    expect(await list('kind=EVOLUTION')).toHaveLength(1);
    expect(await list('module=membres')).toHaveLength(1);
    expect(await list('q=grand%20livre')).toHaveLength(1);
    expect(await list('q=SIG-0001')).toHaveLength(1);
    // % and _ are not patterns.
    expect(await list('q=%25')).toHaveLength(0);
    expect(await list('open=false')).toHaveLength(0);
  });
});

describe('handling a signalement', () => {
  it('changes the state and the priority, closes with a date, and tells the author', async () => {
    const a = await report(alice);
    const res = await call('PATCH', `/feedback/${a.id}`, boss, {
      status: 'IN_PROGRESS',
      priority: 'HIGH',
    });
    expect(res.json()).toEqual({ status: 'IN_PROGRESS', priority: 'HIGH' });
    const mine = (await call('GET', '/feedback/mine', alice)).json()[0];
    expect(mine).toMatchObject({ status: 'IN_PROGRESS', priority: 'HIGH', closedAt: null });
    await call('PATCH', `/feedback/${a.id}`, boss, { status: 'DONE' });
    const done = (await call('GET', `/feedback/${a.id}`, alice)).json();
    expect(done.status).toBe('DONE');
    expect(done.closedAt).not.toBeNull();
    const mails = await mailsTo(aliceEmail);
    expect(mails.map((m) => m.subject).join('|')).toContain('SIG-0001');
    expect(mails.some((m) => m.text?.includes('Terminé'))).toBe(true);
    expect((await call('PATCH', `/feedback/${a.id}`, boss, {})).statusCode).toBe(400);
  });

  it('keeps a conversation: the team’s reply reaches the author, theirs reopens a closed report', async () => {
    const a = await report(alice);
    expect(
      (await call('POST', `/feedback/${a.id}/comments`, boss, { body: 'Pouvez-vous préciser ?' }))
        .statusCode,
    ).toBe(204);
    expect((await mailsTo(aliceEmail)).some((m) => m.text?.includes('Pouvez-vous préciser'))).toBe(
      true,
    );
    await call('PATCH', `/feedback/${a.id}`, boss, { status: 'DONE' });
    expect(
      (await call('POST', `/feedback/${a.id}/comments`, alice, { body: 'Toujours le même souci.' }))
        .statusCode,
    ).toBe(204);
    const detail = (await call('GET', `/feedback/${a.id}`, alice)).json();
    expect(detail.status).toBe('NEW');
    expect(detail.closedAt).toBeNull();
    expect(detail.comments.map((c: { fromTeam: boolean }) => c.fromTeam)).toEqual([true, false]);
    expect(
      (await call('POST', `/feedback/${a.id}/comments`, alice, { body: '  ' })).statusCode,
    ).toBe(400);
  });

  it('records every change in the audit journal', async () => {
    const a = await report(alice);
    await call('PATCH', `/feedback/${a.id}`, boss, { status: 'ACCEPTED' });
    const { rows } = await t.db.execute<{ action: string }>(
      sql`select action from app.audit_log where entity = 'feedback_ticket' order by id`,
    );
    expect(rows.map((r) => r.action)).toEqual(['feedback.create', 'feedback.update']);
  });
});
