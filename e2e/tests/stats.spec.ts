import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('the statistics screen analyses sales and exports to Excel (R-STA-03)', async ({ page }) => {
  await login(page, USERS.admin);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('link', { name: 'Statistiques' })
    .click();
  await expect(page.getByRole('heading', { name: 'Statistiques' })).toBeVisible();
  await page.getByLabel('Regrouper par').selectOption('month');
  await expect(page.getByRole('row', { name: /Total/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Exporter Excel' })).toHaveAttribute(
    'href',
    /format=xlsx/,
  );
});
