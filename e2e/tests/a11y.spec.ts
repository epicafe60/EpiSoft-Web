import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login, USERS } from '../fixtures';

// RGAA / WCAG 2.1 AA smoke test: no serious or critical violation on the main screens.
async function scan(page: Page, name: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    blocking.map((v) => `${v.id} (${v.nodes.length}) : ${v.help}`),
    `${name}: violations d’accessibilité`,
  ).toEqual([]);
}

test('the login page is accessible', async ({ page }) => {
  await page.goto('/connexion');
  await page.getByLabel('Identifiant').waitFor();
  await scan(page, 'connexion');
});

test('customer screens are accessible', async ({ page }) => {
  await login(page, USERS.customer);
  await scan(page, 'accueil');
  await page.getByRole('link', { name: 'Boutique' }).first().click();
  await page.getByRole('heading', { name: /Boutique/ }).first().waitFor();
  await scan(page, 'boutique');
  await page.goto('/mon-foyer');
  await page.getByRole('heading', { name: 'Mon foyer' }).waitFor();
  await scan(page, 'mon foyer');
});

test('staff screens are accessible', async ({ page }) => {
  await login(page, USERS.admin);
  for (const [path, heading] of [
    ['/membres', /Membres|Adhérents/],
    ['/appros/stock', /Approvisionnement|Stock/],
    ['/catalogue', /Catalogue|Produits/],
  ] as const) {
    await page.goto(path);
    await page.getByRole('heading', { name: heading }).first().waitFor();
    await scan(page, path);
  }
});
