import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { closeTillSessions, query, scan, setMemberFirst, startTill } from '../helpers';
import { SEED } from '../seed';
import { WEB_PORT } from '../playwright.config';

// Evolutions of the migration needs (docs/evols): till rules R-EVO-01, R-EVO-02.

// Leave nothing open: the other scenarios declare their own tills and open their own sessions.
test.afterEach(() => closeTillSessions('EVO'));
test.afterAll(() => setMemberFirst(false));

test('R-EVO-01: no article without a member or a passing membership, whose amount can be changed', async ({
  page,
}) => {
  await setMemberFirst(true);
  await startTill(page, 'EVO1');

  // Nothing can be added before the member is chosen.
  await scan(page, SEED.chips.ean);
  await expect(page.getByRole('alert')).toContainText('Choisissez d’abord l’adhérent');
  await expect(page.getByTestId('ticket-total')).toHaveText(/0,00/);

  // Passing membership: the amount is proposed (2,00 €) and editable (1,00 €).
  await page.getByRole('button', { name: /Adhésion de passage/ }).click();
  const line = page.getByRole('dialog', { name: 'Adhésion de passage' });
  await line.getByLabel('Prix unitaire (€)').fill('1,00');
  await line.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByTestId('ticket-total')).toHaveText(/1,00/);

  // The membership is on the ticket: articles are now accepted.
  await scan(page, SEED.chips.ean);
  await expect(page.getByTestId('ticket-total')).toHaveText(/3,50/);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Règlement' });
  await dialog.getByRole('radio', { name: 'Espèces' }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await dialog.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page.getByText(/Ticket E2E?[A-Z0-9]*-?[0-9]+ enregistré|enregistré/)).toBeVisible();
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 15_000 });

  const rows = await query<{ unit_price: string; catalog_price: string }>(
    `select l.unit_price, l.catalog_price from app.sale_line l join app.sale s on s.id = l.sale_id
     join app.pos_device d on d.id = s.device_id join app.product p on p.id = l.product_id
     where d.name = 'EVO1' and p.code = '01001'`,
  );
  expect(rows).toEqual([{ unit_price: '1.0000', catalog_price: '2.0000' }]);
});

test('R-EVO-08: a donation is recorded from the till without a member, with its own amount', async ({
  page,
}) => {
  await setMemberFirst(true);
  await startTill(page, 'EVO2');
  await page.getByRole('button', { name: 'Don', exact: true }).click();
  const line = page.getByRole('dialog', { name: 'Don' });
  await line.getByLabel('Prix unitaire (€)').fill('5');
  await line.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByTestId('ticket-total')).toHaveText(/5,00/);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Règlement' });
  await dialog.getByRole('radio', { name: 'Chèque' }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await dialog.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 15_000 });
  const donations = () =>
    query<{ unit_price: string }>(
      `select l.unit_price from app.sale_line l join app.sale s on s.id = l.sale_id
     join app.pos_device d on d.id = s.device_id join app.product p on p.id = l.product_id
     where d.name = 'EVO2' and p.code = '01004'`,
    );
  await expect.poll(donations, { timeout: 15_000 }).toEqual([{ unit_price: '5.0000' }]);
});

test('R-EVO-03 / R-EVO-02: matches appear while typing; no payment method is preselected', async ({
  page,
}) => {
  await setMemberFirst(false);
  await startTill(page, 'EVO3');
  await page.getByLabel('Scanner ou rechercher un produit (F2)').fill('chips');
  const option = page.getByRole('option', { name: /Chips nature/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByTestId('ticket-total')).toHaveText(/2,50/);

  await page.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Règlement' });
  await expect(dialog.getByRole('radio', { name: 'Espèces' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(dialog.getByRole('button', { name: 'Ajouter' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Valider le ticket' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Espèces' }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await expect(dialog.getByRole('button', { name: 'Valider le ticket' })).toBeEnabled();
});

test('R-EVO-06: a second till joins the open session and sells in it', async ({
  page,
  browser,
}) => {
  await setMemberFirst(false);
  await startTill(page, 'EVO4');

  const other = await browser.newContext({
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  const page2 = await other.newPage();
  await login(page2, USERS.cashier);
  await page2.goto('/caisse');
  await page2.getByLabel('Nom du poste').fill('EVO5');
  await page2.getByRole('button', { name: 'Déclarer le poste' }).click();
  await expect(page2.getByText('Une session est déjà ouverte dans l’épicerie')).toBeVisible({
    timeout: 15_000,
  });
  // Other scenarios may have left sessions open: join the one of EVO4.
  await page2
    .locator('div.justify-between', { hasText: /EVO4, ouverte/ })
    .getByRole('button', { name: 'Rejoindre cette session' })
    .click();
  await expect(page2.getByLabel('Scanner ou rechercher un produit (F2)')).toBeVisible();

  const scan2 = page2.getByLabel('Scanner ou rechercher un produit (F2)');
  await scan2.fill(SEED.chips.ean);
  await scan2.press('Enter');
  await page2.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page2.getByRole('dialog', { name: 'Règlement' });
  await dialog.getByRole('radio', { name: 'Espèces' }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await dialog.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page2.getByText(/Ticket .* enregistré/)).toBeVisible();

  const sessions = () =>
    query<{ device: string; opener: string }>(
      `select d.name as device, o.name as opener from app.sale s
       join app.pos_device d on d.id = s.device_id
       join app.cash_session cs on cs.id = s.session_id
       join app.pos_device o on o.id = cs.device_id
       where d.name = 'EVO5'`,
    );
  await expect.poll(sessions, { timeout: 20_000 }).toEqual([{ device: 'EVO5', opener: 'EVO4' }]);
  await other.close();
});
