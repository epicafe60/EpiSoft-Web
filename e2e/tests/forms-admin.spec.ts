import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';
import { SEED } from '../seed';

// Back-office forms that had no end-to-end test: shelves, supplier invoices, the cashier setting
// and the clearing of a forgotten cashier code.

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

test('a universe and a shelf are created, with the digits of their codes checked', async ({
  page,
}) => {
  const universe = `Univers ${unique()}`;
  const shelf = `Rayon ${unique()}`;
  await login(page, USERS.admin);
  await page.goto('/catalogue/rayons');

  const newUniverse = page.locator('div', { has: page.getByLabel('Code de l’univers') }).last();
  await page.getByLabel('Code de l’univers').fill('8');
  await page.getByLabel('Nom de l’univers').fill(universe);
  await newUniverse.getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.getByText(universe)).toBeVisible();

  // The new universe has its own « new shelf » line: its code is two digits.
  const card = page.locator('div', { has: page.getByLabel('Code du nouveau rayon') }).last();
  await card.getByLabel('Code du nouveau rayon').fill('7');
  await card.getByLabel('Nom du nouveau rayon').fill(shelf);
  await card.getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.getByRole('alert')).toBeVisible(); // « Deux chiffres. » — a shelf code has 2 digits
  await card.getByLabel('Code du nouveau rayon').fill('71');
  await card.getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.getByRole('textbox', { name: 'Rayon 71' })).toHaveValue(shelf);
  const rows = await query<{ code: string }>(
    `select c.code from app.category c join app.universe u on u.id = c.universe_id where u.name = '${universe}' and c.name = '${shelf}'`,
  );
  expect(rows).toEqual([{ code: '71' }]);
});

test('a supplier invoice is entered, with a zero VAT', async ({ page }) => {
  const piece = `F-${unique()}`;
  await login(page, USERS.admin);
  await page.goto('/appros/factures/nouvelle');
  await page.getByLabel('Fournisseur').fill(SEED.honey.supplier);
  await page.getByLabel('Date', { exact: true }).fill('2026-11-02');
  await page.getByLabel('Total HT (€)').fill('120,50');
  await page.getByLabel('TVA (€)').fill('0');
  await page.getByLabel('Total TTC (€)').fill('120,50');
  // The piece number is required: refused under its field.
  await page.getByRole('button', { name: 'Créer la facture' }).click();
  await expect(page.getByText('N° de pièce requis.')).toBeVisible();
  await page.getByLabel('N° de pièce').fill(piece);
  await page.getByRole('button', { name: 'Créer la facture' }).click();
  await expect(page.getByRole('button', { name: 'Enregistrer le règlement' })).toBeVisible();
  const rows = await query<{ total_incl: string; total_vat: string }>(
    `select total_incl, total_vat from app.supplier_invoice where piece_ref = '${piece}'`,
  );
  expect(rows).toEqual([{ total_incl: '120.50', total_vat: '0.00' }]);
});

test('the cashier-code setting is saved and read back', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/parametres');
  const form = page.locator('form', { has: page.getByLabel('Code caissier exigé (4 chiffres)') });
  const box = form.getByLabel('Code caissier exigé (4 chiffres)');
  await expect(box).toBeChecked(); // the default
  await box.uncheck();
  await form.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(form.getByRole('status')).toHaveText('Enregistré.');
  const [saved] = await query<{ value: { requirePin: boolean } }>(
    `select value from app.setting where key = 'pos.cashierSwitch'`,
  );
  expect(saved!.value).toEqual({ requirePin: false });
  await page.reload();
  await expect(
    page
      .locator('form', { has: page.getByLabel('Code caissier exigé (4 chiffres)') })
      .getByLabel('Code caissier exigé (4 chiffres)'),
  ).not.toBeChecked();
  // Leave the default for the other scenarios.
  await query(`delete from app.setting where key = 'pos.cashierSwitch'`);
});

test('an administrator clears a forgotten cashier code (R-SES-07)', async ({ page }) => {
  await query(
    `update app.member set till_password_hash = 'x', till_password_salt = 'y' where username = '${USERS.cashier.username}'`,
  );
  await login(page, USERS.admin);
  await page.goto('/admin/utilisateurs');
  await page.getByLabel('Rechercher un membre').fill('Carl');
  const row = page.getByRole('row', { name: /CAISSE Carl|Carl CAISSE/ });
  await row.getByRole('button', { name: 'Effacer le code caissier' }).click();
  await expect(row.getByRole('button', { name: 'Effacer le code caissier' })).toHaveCount(0);
  const [m] = await query<{ till_password_hash: string | null }>(
    `select till_password_hash from app.member where username = '${USERS.cashier.username}'`,
  );
  expect(m!.till_password_hash).toBeNull();
  const log = await query(`select 1 from app.audit_log where action = 'member.till_pin_clear'`);
  expect(log.length).toBeGreaterThan(0);
});

test('a cashier is sent back home from the shelves, the invoices and the settings', async ({
  page,
}) => {
  await login(page, USERS.cashier);
  for (const path of ['/catalogue/rayons', '/appros/factures/nouvelle', '/admin/parametres']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/$/); // sent back to the home page
  }
});
