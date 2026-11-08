import { expect, test, type Page } from '@playwright/test';
import { USERS } from '../fixtures';
import { closeAllSessions, query, scan, setMemberFirst, startTill } from '../helpers';
import { SEED } from '../seed';

// R-SES-07: the cashiers take turns without signing out. Carl opens the till; Alice takes it by
// touching her name and typing her code; her tickets are in her name, through Carl's session, and
// the rest of the application waits for Carl's password.

test.beforeAll(() => setMemberFirst(false));
test.afterEach(async () => {
  await closeAllSessions();
  await query(
    `update app.member set till_password_hash = null, till_password_salt = null where username = '${USERS.admin.username}'`,
  );
  await query(`delete from app.setting where key = 'pos.cashierSwitch'`);
});

/** A till name of its own for each test run: a name taken by an earlier run gets replaced. */
const till = (n: number) => `RELAIS${n}-${Date.now().toString(36).slice(-5)}`;

async function sellOne(page: Page) {
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await pay.getByRole('radio', { name: 'Espèces' }).click();
  await pay.getByLabel('Montant remis').fill('2.50');
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await pay.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page.getByText(/Ticket .* enregistré/)).toBeVisible();
}

/** The cashier of the last ticket of a till, as recorded by the server. */
const lastCashier = (device: string) =>
  query<{ first_name: string }>(
    `select m.first_name from app.sale s join app.member m on m.id = s.cashier_id
     where s.provisional_number like '${device}-%' order by s.created_at desc limit 1`,
  ).then((r) => r[0]?.first_name ?? null);

async function takeTillWithNewCode(page: Page, pin: string) {
  await page.getByRole('button', { name: 'Changer de caissier' }).click();
  const who = page.getByRole('dialog', { name: 'Qui encaisse ?' });
  await who.getByRole('button', { name: /Alice ADMIN/ }).click();
  const create = page.getByRole('dialog', { name: 'Alice ADMIN' });
  await create.getByLabel('Code caissier (4 chiffres)').fill(pin);
  await create.getByLabel('Le même code, encore une fois').fill(pin);
  await create.getByLabel('Votre mot de passe EpiSoft').fill(USERS.admin.password);
  await create.getByRole('button', { name: 'Choisir ce code' }).click();
  await expect(create).toBeHidden();
}

test('another cashier takes the till with their code, and the session is theirs at the till only', async ({
  page,
}) => {
  const device = till(1);
  await startTill(page, device);
  await sellOne(page);
  await expect.poll(() => lastCashier(device)).toBe('Carl');

  await takeTillWithNewCode(page, '4815');
  await expect(
    page.getByRole('button', { name: /Alice ADMIN · poste de Carl CAISSE/ }),
  ).toBeVisible();
  await expect(page.getByText(/Encaissé par :\s*Alice ADMIN/)).toBeVisible();
  await sellOne(page);
  await expect.poll(() => lastCashier(device)).toBe('Alice');
  // The journal names both: Alice, through Carl's session, with her code checked.
  const [entry] = await query<{ via: string; check: string }>(
    `select v.first_name as via, a.after ->> 'cashierCheck' as check
     from app.audit_log a join app.member v on v.id = a.via_session_of_id
     where a.action = 'sale.create' order by a.at desc limit 1`,
  );
  expect(entry).toEqual({ via: 'Carl', check: 'PIN' });

  // The rest of the application waits for Carl's password.
  await page.getByRole('link', { name: 'Retour au back-office' }).click();
  await expect(
    page.getByRole('heading', { name: 'La caisse est tenue par Alice ADMIN' }),
  ).toBeVisible();
  await page.getByLabel('Mot de passe de Carl CAISSE').fill(USERS.cashier.password);
  await page.getByRole('button', { name: 'Revenir à mon compte' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour Carl' })).toBeVisible();
});

test('offline, the code is checked on the till, and the session is restricted once back online', async ({
  page,
  context,
}) => {
  const device = till(2);
  await startTill(page, device);
  await takeTillWithNewCode(page, '4815');
  // Carl takes the till back; the till now knows Alice's code.
  await page.getByRole('button', { name: /Alice ADMIN · poste de Carl CAISSE/ }).click();
  await page
    .getByRole('dialog', { name: 'Qui encaisse ?' })
    .getByRole('button', { name: /Carl CAISSE/ })
    .click();
  await page.getByLabel('Mot de passe de Carl CAISSE').fill(USERS.cashier.password);
  await page.getByRole('button', { name: 'Revenir à mon compte' }).click();
  await expect(page.getByRole('button', { name: 'Carl CAISSE', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Scanner ou rechercher un produit (F2)')).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Changer de caissier' }).click();
  await page
    .getByRole('dialog', { name: 'Qui encaisse ?' })
    .getByRole('button', { name: /Alice ADMIN/ })
    .click();
  const pinDialog = page.getByRole('dialog', { name: 'Alice ADMIN' });
  await pinDialog.getByLabel('Code caissier (4 chiffres)').fill('1111');
  await pinDialog.getByRole('button', { name: 'Valider' }).click();
  await expect(pinDialog.getByText('Code incorrect.')).toBeVisible();
  await pinDialog.getByLabel('Code caissier (4 chiffres)').fill('4815');
  await pinDialog.getByRole('button', { name: 'Valider' }).click();
  await expect(pinDialog).toBeHidden();
  await sellOne(page);

  await context.setOffline(false);
  await expect.poll(() => lastCashier(device), { timeout: 30_000 }).toBe('Alice');
  // The ticket of Alice, received, restricts Carl's session to the till.
  await expect
    .poll(async () => {
      const [s] = await query<{ restricted: boolean }>(
        `select s.till_cashier_id is not null as restricted from app.session s
         join app.member m on m.id = s.member_id where m.username = '${USERS.cashier.username}'
         order by s.created_at desc limit 1`,
      );
      return s?.restricted;
    })
    .toBe(true);
});

test('the cashier is checked and changed on the payment screen, right before validating', async ({
  page,
}) => {
  const device = till(4);
  await startTill(page, device);
  await takeTillWithNewCode(page, '4815');
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await expect(pay.getByText(/Encaissé par :\s*Alice ADMIN/)).toBeVisible();
  // Alice hands over to Carl before validating: his password takes the till back.
  await pay.getByRole('button', { name: 'Changer de caissier' }).click();
  await page
    .getByRole('dialog', { name: 'Qui encaisse ?' })
    .getByRole('button', { name: /Carl CAISSE/ })
    .click();
  await page.getByLabel('Mot de passe de Carl CAISSE').fill(USERS.cashier.password);
  await page.getByRole('button', { name: 'Revenir à mon compte' }).click();
  await expect(pay.getByText(/Encaissé par :\s*Carl CAISSE/)).toBeVisible();
  await pay.getByRole('radio', { name: 'Espèces' }).click();
  await pay.getByLabel('Montant remis').fill('2.50');
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await pay.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page.getByText(/Ticket .* enregistré/)).toBeVisible();
  await expect.poll(() => lastCashier(device)).toBe('Carl');
});

test('without the code required, one touch is enough, and the journal says « non vérifié »', async ({
  page,
}) => {
  await query(
    `insert into app.setting (key, value) values ('pos.cashierSwitch', '{"requirePin": false}')
     on conflict (key) do update set value = excluded.value`,
  );
  const device = till(3);
  await startTill(page, device);
  await page.getByRole('button', { name: 'Changer de caissier' }).click();
  await page
    .getByRole('dialog', { name: 'Qui encaisse ?' })
    .getByRole('button', { name: /Alice ADMIN/ })
    .click();
  await expect(page.getByRole('dialog', { name: 'Qui encaisse ?' })).toBeHidden();
  await sellOne(page);
  await expect.poll(() => lastCashier(device)).toBe('Alice');
  const [entry] = await query<{ check: string }>(
    `select a.after ->> 'cashierCheck' as check from app.audit_log a
     where a.action = 'sale.create' order by a.at desc limit 1`,
  );
  expect(entry!.check).toBe('DECLARED');
});
