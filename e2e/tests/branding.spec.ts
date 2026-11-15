import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';

// The name, the colour and the logo of the application are set by the association (Administration ›
// Paramètres) and shown everywhere, signed in or not.

test.afterEach(async () => {
  await query(`delete from app.setting where key = 'app.branding'`);
});

test('an association gives its own name and colour to the application', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/parametres');
  const card = page.locator('form', { has: page.getByLabel('Nom du logiciel') });

  // Too light a colour is refused under its field, and nothing is saved.
  await card.getByLabel('Nom du logiciel').fill('GestEpicerie');
  await card.getByLabel('Nom court de l’association').fill('Le Panier');
  await card.getByRole('textbox', { name: 'Couleur principale' }).fill('#ffee00');
  await card.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(card.getByText('Couleur trop claire')).toBeVisible();

  await card.getByRole('textbox', { name: 'Couleur principale' }).fill('#1d4ed8');
  await card.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(card.getByRole('status')).toHaveText('Enregistré.');

  // The menu and the title of the page follow.
  await page.reload();
  await expect(page).toHaveTitle('GestEpicerie');
  await expect(page.getByText('GestEpicerie').first()).toBeVisible();

  // The sign-in page too, without being signed in.
  await page.context().clearCookies();
  await page.goto('/connexion');
  await expect(page.getByText('Identifiez-vous pour accéder à GestEpicerie.')).toBeVisible();
  await expect(page).toHaveTitle('GestEpicerie');

  // And the manifest of the installed app.
  const manifest = await page.request.get('/api/v1/branding/manifest.webmanifest');
  expect(await manifest.json()).toMatchObject({
    short_name: 'GestEpicerie',
    theme_color: '#1d4ed8',
  });
});
