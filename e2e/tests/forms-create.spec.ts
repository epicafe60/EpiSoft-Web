import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';

// The creation forms, filled the way a volunteer fills them (reported by a user: a new town could
// not be entered on a supplier, and a new product was refused with no hint). Each form is
// opened, filled, saved, and the saved sheet is read back.

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

test('a supplier is created with only a name', async ({ page }) => {
  const name = `Ferme ${unique()}`;
  await login(page, USERS.admin);
  await page.goto('/appros/fournisseurs/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Créer le fournisseur' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  const rows = await query<{ code: string }>(
    `select code from app.supplier where name = '${name}'`,
  );
  expect(rows).toHaveLength(1);
});

test('a supplier in a town that is not in the list: the postcode and the new town are entered', async ({
  page,
}) => {
  const name = `Ferme ${unique()}`;
  const town = `Ville ${unique()}`;
  await login(page, USERS.admin);
  await page.goto('/appros/fournisseurs/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill(name);
  await page.getByLabel('Code postal').fill('60240');
  await page.getByLabel('Commune', { exact: true }).selectOption({ label: 'Autre commune…' });
  await page.getByLabel('Nom de la nouvelle commune').fill(town);
  await page.getByRole('button', { name: 'Ajouter la commune' }).click();
  // The town is now chosen in the list, with its postcode.
  await expect(page.getByLabel('Commune', { exact: true })).toContainText(`${town} (60240)`);
  await page.getByRole('button', { name: 'Créer le fournisseur' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  const rows = await query<{ postcode: string; town: string }>(
    `select s.postcode, c.name as town from app.supplier s join app.commune c on c.id = s.commune_id where s.name = '${name}'`,
  );
  expect(rows).toEqual([{ postcode: '60240', town }]);
});

test('a supplier postcode that is not 5 digits is refused under its field', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/appros/fournisseurs/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill(`Ferme ${unique()}`);
  await page.getByLabel('Code postal').fill('6024');
  await page.getByRole('button', { name: 'Créer le fournisseur' }).click();
  await expect(page.getByText('Code postal à 5 chiffres.')).toBeVisible();
  await expect(page).toHaveURL(/fournisseurs\/nouveau$/);
});

test('a product is created with a name, a code and a selling price', async ({ page }) => {
  const name = `Lentilles ${unique()}`;
  const code = String(900000 + Math.floor(Math.random() * 99999));
  await login(page, USERS.admin);
  await page.goto('/catalogue/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill(name);
  await page.getByLabel('Code', { exact: true }).fill(code);
  await page.getByLabel('PA HT (€)').fill('1,20');
  await page.getByLabel('Prix de vente TTC (€)').fill('2,50');
  await page.getByLabel('Codes-barres').fill('4006381333931');
  await page.getByRole('button', { name: 'Créer le produit' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const rows = await query<{ sale_price: string }>(
    `select sale_price from app.product where code = '${code}'`,
  );
  expect(rows).toEqual([{ sale_price: '2.50' }]);
});

test('a refused product says which field is wrong', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/catalogue/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill(`Sans prix ${unique()}`);
  await page.getByLabel('Codes-barres').fill('3168930167984');
  await page.getByRole('button', { name: 'Créer le produit' }).click();
  const summary = page.getByText('Certaines valeurs sont invalides :');
  await expect(summary).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Prix de vente TTC :' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Codes-barres :' })).toBeVisible();
});
