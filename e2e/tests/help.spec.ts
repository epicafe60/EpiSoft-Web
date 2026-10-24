import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('the help page answers the situations of the role, and only those', async ({ page }) => {
  await login(page, USERS.cashier);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('link', { name: 'Aide' })
    .click();
  await expect(page.getByRole('heading', { name: /Aide : que faire si/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'À la caisse' })).toBeVisible();
  // A cashier has no business with the responsables' section.
  await expect(page.getByRole('heading', { name: 'Pour les responsables' })).toHaveCount(0);
  await page.getByText('Un ticket apparaît « refusé » en haut de l’écran').click();
  await expect(page.getByText(/Ressaisir ce ticket/).first()).toBeVisible();
});

test('an administrator sees every section, and the till links to the help', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/aide');
  for (const title of [
    'À la caisse',
    'Approvisionnements et stock',
    'Adhérents et cagnotte',
    'Pour les responsables',
  ])
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
});

test('the activity feed lists the latest changes in plain sentences', async ({ page }) => {
  await login(page, USERS.admin);
  // Make one change, so that the test does not depend on what ran before it.
  const saved = await page.request.put('/api/v1/settings/pos.sellToNonMembers', {
    data: { enabled: true },
    headers: { 'x-episoft-csrf': '1' },
  });
  expect(saved.ok()).toBe(true);
  await page.goto('/surveillance/activite');
  const feed = page.getByRole('list', { name: 'Derniers changements' });
  await expect(feed).toBeVisible();
  await expect(feed).toContainText('a modifié un réglage');
  await expect(feed).not.toContainText(/product\.|setting\.|session\./);
});
