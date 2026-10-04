import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('a wrong password is refused with a clear message', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/connexion/);
  await page.getByLabel('Identifiant').fill(USERS.cashier.username);
  await page.getByLabel('Mot de passe').fill('pas le bon');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toHaveText('Identifiant ou mot de passe incorrect.');
});

test('the menu only shows the modules of the user roles (R-AUTH-05)', async ({ page }) => {
  await login(page, USERS.cashier);
  const nav = page.getByRole('navigation', { name: 'Menu principal' });
  await expect(nav.getByRole('link', { name: 'Caisse' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Comptabilité' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  // A direct URL to a module without the role goes back home.
  await page.goto('/admin/parametres');
  await expect(page).toHaveURL(/\/$/);
});

test('an administrator changes a setting and sees it in the audit log (R-ADM-01, R-ADM-02)', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/admin/parametres');
  const form = page.locator('form', { has: page.getByLabel('Montant (€)') });
  await form.getByLabel('Montant (€)').fill('150,5');
  await form.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(form.getByRole('status')).toHaveText('Enregistré.');
  await expect(form.getByLabel('Montant (€)')).toHaveValue('150.50');

  await page.getByRole('link', { name: 'Journal d’audit' }).click();
  await expect(page.getByRole('cell', { name: 'Paramètre modifié' }).first()).toBeVisible();

  // The change reads as a comparison (added lines in green, removed in red), not as raw JSON.
  const row = page.getByRole('row', { name: /Paramètre modifié/ }).first();
  await row.getByText(/^Détail/).click();
  const diff = row.getByRole('group', { name: 'Comparaison avant / après' });
  await expect(diff).toContainText('150.5');
  await expect(diff.getByText('+', { exact: true }).first()).toBeVisible();
});

test('logout returns to the login page', async ({ page }) => {
  await login(page, USERS.cashier);
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/connexion/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/connexion/);
});
