import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createUser, login, setupTestApp } from './helpers';

// Protections on the member side: the same person twice, the cagnotte shown on the sheet.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let h: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  await t.db.execute(
    sql`truncate app.wallet_entry, app.member_payment, app.membership, app.household cascade`,
  );
  h = await login(t.app, (await createUser(t.db, { roles: ['ADHERENTS'] })).username!);
});

const newMember = {
  lastName: 'Dupont',
  firstName: 'Marie',
  street: null,
  postcode: null,
  communeId: null,
  phone: '06 12 34 56 78',
  email: null,
  status: 'ACTIVE',
  publicVisible: false,
  newsletter: false,
  username: null,
  householdId: null,
};

const create = async (over: object = {}) => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/members',
    headers: h,
    payload: { ...newMember, ...over },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; householdId: string };
};

const twins = async (q: Record<string, string>) =>
  (
    await t.app.inject({
      url: `/api/v1/members/duplicates?${new URLSearchParams(q)}`,
      headers: h,
    })
  ).json() as { id: string; number: number }[];

describe('the same person twice', () => {
  it('finds a card with the same name, whatever the accents and the case', async () => {
    const a = await create();
    expect((await twins({ firstName: 'MARIE', lastName: 'dupont' })).map((m) => m.id)).toEqual([
      a.id,
    ]);
    expect(await twins({ firstName: 'Marie', lastName: 'Martin' })).toEqual([]);
  });

  it('finds a card with the same phone number, whatever its format', async () => {
    const a = await create();
    const found = await twins({ firstName: 'Paul', lastName: 'Autre', phone: '+33 6 12 34 56 78' });
    expect(found.map((m) => m.id)).toEqual([a.id]);
  });

  it('does not point a member at themselves, nor at an archived card', async () => {
    const a = await create();
    expect(await twins({ firstName: 'Marie', lastName: 'Dupont', exceptId: a.id })).toEqual([]);
    await t.db.execute(sql`update app.member set status = 'ARCHIVED' where id = ${a.id}`);
    expect(await twins({ firstName: 'Marie', lastName: 'Dupont' })).toEqual([]);
  });

  it('says nothing about an empty search', async () => {
    await create();
    expect(await twins({ firstName: '', lastName: '' })).toEqual([]);
  });

  it('is reserved to the members team', async () => {
    const cashier = await login(t.app, (await createUser(t.db, { roles: ['CAISSE'] })).username!);
    const res = await t.app.inject({
      url: '/api/v1/members/duplicates?firstName=Marie&lastName=Dupont',
      headers: cashier,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('the cagnotte on the member sheet', () => {
  it('shows the balance of the household, to warn before archiving someone who has money in it', async () => {
    const a = await create();
    await t.db.execute(sql`insert into app.wallet_entry (id, household_id, amount, kind)
      values (gen_random_uuid(), ${a.householdId}, 12.5, 'CORRECTION')`);
    const sheet = (await t.app.inject({ url: `/api/v1/members/${a.id}`, headers: h })).json();
    expect(sheet.householdBalance).toBe('12.50');
  });
});
