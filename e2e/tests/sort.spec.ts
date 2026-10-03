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
