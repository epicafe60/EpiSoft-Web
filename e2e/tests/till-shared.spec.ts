import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { closeAllSessions, nameTill, query, scan, setMemberFirst, startTill } from '../helpers';
import { SEED } from '../seed';
import { WEB_PORT } from '../playwright.config';

// R-SES-05 and R-SES-06: the shop has one till session a day; everyone joins it, and the closing
// says who else is still there.

test.beforeAll(() => setMemberFirst(false));
test.afterEach(async () => {
  await closeAllSessions();
  await query(`delete from app.pos_device where name = 'ANCIENPOSTE' and not exists (
    select 1 from app.cash_session where device_id = pos_device.id)`);
});

async function sellOne(page: import('@playwright/test').Page) {
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await pay.getByRole('radio', { name: 'Espèces' }).click();
  await pay.getByLabel('Montant remis').fill('2.50');
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await pay.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page.getByText(/Ticket .* enregistré/)).toBeVisible();
}

test('the closing tells who else sold lately in the shared session', async ({ page, browser }) => {
  await startTill(page, 'SHARE1');
  const other = await browser.newContext({
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  try {
    const page2 = await other.newPage();
    await nameTill(page2, 'SHARE2');
    await login(page2, USERS.admin);
    await page2.goto('/caisse');
    // Alice joins the session Carl opened, and sells in it.
    await expect(page2.getByLabel('Scanner ou rechercher un produit (F2)')).toBeVisible({
      timeout: 15_000,
    });
    await sellOne(page2);
    await expect
      .poll(
        async () =>
          (await query(`select 1 from app.sale s where s.provisional_number like 'SHARE2-%'`))
            .length,
      )
      .toBe(1);

    // The header names who is connected: Carl sees himself (highlighted) and Alice.
    const connected = page.getByRole('list', { name: 'Caissiers connectés' });
    await expect(connected.getByRole('listitem').filter({ hasText: 'Carl CAISSE' })).toBeVisible();
    await expect(connected.getByRole('listitem').filter({ hasText: 'Alice ADMIN' })).toBeVisible({
      timeout: 40_000,
    });

    // Carl closes: he is told Alice sold a minute ago.
    await page.getByRole('link', { name: 'Clôture' }).click();
    // The closing counts the tickets of everyone in the session, not only his own.
    await expect(page.getByText('Tickets de la session')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('1 (annulations : 0)')).toBeVisible();
    // The count has the 200 and 100 euro notes, which add up like the others.
    await page.getByLabel('200 €', { exact: true }).fill('1');
    await page.getByLabel('100 €', { exact: true }).fill('2');
    await expect(page.getByText('Espèces comptées : 400,00')).toBeVisible();
    await expect(page.getByText('Encore actif dans cette caisse')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Alice ADMIN \(dernier ticket il y a \d+ min\)/)).toBeVisible();
  } finally {
    await other.close();
  }
});

test('a session left open since the day before is closed first', async ({ page }) => {
  await closeAllSessions();
  await query(
    `insert into app.pos_device (id, name) values (gen_random_uuid(), 'ANCIENPOSTE')
     on conflict (name) do nothing`,
  );
  await query(
    `insert into app.cash_session (id, device_id, opened_at, opening_float)
     select gen_random_uuid(), id, now() - interval '2 days', 40 from app.pos_device where name = 'ANCIENPOSTE'`,
  );
  await nameTill(page, 'SHARE3');
  await login(page, USERS.cashier);
  await page.goto('/caisse');
  await expect(page.getByText('La caisse d’hier n’est pas clôturée')).toBeVisible({
    timeout: 15_000,
  });
  // Nothing can be sold meanwhile: the way out is the closing.
  await expect(page.getByLabel('Scanner ou rechercher un produit (F2)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clôturer cette caisse' }).click();
  await expect(
    page.getByRole('heading', { name: /Clôture de la session ouverte le/ }),
  ).toBeVisible();
});
