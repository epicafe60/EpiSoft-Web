import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';
import { SEED } from '../seed';

// Members, and the changes made to existing sheets, through the real forms.

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

test('a member is created; a postcode that is not 5 digits is refused first', async ({ page }) => {
  const last = `Test${unique()}`;
  await login(page, USERS.admin);
  await page.goto('/membres/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill(last);
  await page.getByLabel('Prénom', { exact: true }).fill('Camille');
  await page.getByLabel('Code postal').fill('6024');
  await page.getByLabel('La personne a pris connaissance de la politique de confidentialité').check();
  await page.getByRole('button', { name: 'Créer le membre' }).click();
  await expect(page.getByText('Code postal à 5 chiffres.')).toBeVisible();
  await page.getByLabel('Code postal').fill('60240');
  await page.getByRole('button', { name: 'Créer le membre' }).click();
  const postcodes = () =>
    query<{ postcode: string }>(`select postcode from app.member where last_name = '${last}'`);
  await expect.poll(async () => (await postcodes()).length).toBe(1);
  expect((await postcodes())[0]!.postcode).toBe('60240');
});

test('a supplier sheet is changed, saved and read back after a reload', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/appros/fournisseurs');
  await page.getByRole('link', { name: SEED.honey.supplier }).click();
  const phone = `03 44 ${String(Math.floor(Math.random() * 90) + 10)} 00 00`;
  await page.getByLabel('Téléphone').fill(phone);
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Fiche enregistrée.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Téléphone')).toHaveValue(phone);
});

test('a supplier paid « à réception fin de mois » is saved, read back, and its payment terms are set aside', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/appros/fournisseurs');
  await page.getByRole('link', { name: SEED.honey.supplier }).click();
  const terms = page.getByLabel('Délai de paiement (jours)');
  await expect(terms).toBeEnabled();
  await page.getByLabel('À réception fin de mois').check();
  await expect(terms).toBeDisabled();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Fiche enregistrée.')).toBeVisible();
  const [saved] = await query<{ pay_at_month_end: boolean }>(
    `select pay_at_month_end from app.supplier where name = '${SEED.honey.supplier}'`,
  );
  expect(saved!.pay_at_month_end).toBe(true);
  await page.reload();
  await expect(page.getByLabel('À réception fin de mois')).toBeChecked();
  // Put back, so that the other tests keep the usual terms.
  await page.getByLabel('À réception fin de mois').uncheck();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Fiche enregistrée.')).toBeVisible();
  await expect(page.getByLabel('Délai de paiement (jours)')).toBeEnabled();
});

test('a product sheet is changed and saved; a stale sheet is refused with an explanation', async ({
  browser,
}) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a, USERS.admin);
  await login(b, USERS.admin);
  const [row] = await query<{ id: string }>(
    `select id from app.product where code = '${SEED.honey.code}'`,
  );
  const id = row!.id;
  await a.goto(`/catalogue/${id}`);
  await b.goto(`/catalogue/${id}`);
  await expect(a.getByLabel('Libellé du bouton')).toBeVisible();
  await expect(b.getByLabel('Libellé du bouton')).toBeVisible();

  await a.getByLabel('Libellé du bouton').fill(`Miel ${unique()}`.slice(0, 20));
  await a.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(a.getByText('Produit enregistré.')).toBeVisible();

  // The second window still holds the old version: its save is refused, not silently applied.
  await b.getByLabel('Libellé du bouton').fill('Autre libellé');
  await b.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(b.getByText(/modifiée entre-temps/)).toBeVisible();
});

test('a cashier sees no button to create a supplier, a product or a member', async ({ page }) => {
  await login(page, USERS.cashier);
  for (const [path, label] of [
    ['/appros/fournisseurs', 'Nouveau fournisseur'],
    ['/catalogue', 'Nouveau produit'],
    ['/membres', 'Nouveau membre'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: label })).toHaveCount(0);
  }
});
