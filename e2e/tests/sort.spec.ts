import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('a table sorts when its column header is clicked', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/utilisateurs');
  const header = page.getByRole('columnheader', { name: /Membre/ });
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
});

test('a third click restores the original order, and a column can be searched', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/admin/utilisateurs');
  const header = page.getByRole('columnheader', { name: /Membre/ });
  const click = () => header.getByRole('button').click();
  await click();
  await click();
  await click();
  await expect(header).toHaveAttribute('aria-sort', 'none');

  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  expect(before).toBeGreaterThan(1);
  await page.getByLabel(/Filtrer la colonne Membre/).fill('alice');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('ADMIN');
  await page.getByLabel(/Filtrer la colonne Membre/).fill('zzzzzz');
  await expect(page.getByText('Aucun résultat pour ces filtres.')).toBeVisible();
  await page.getByRole('button', { name: 'Effacer les filtres' }).click();
  await expect(rows).toHaveCount(before);
});
