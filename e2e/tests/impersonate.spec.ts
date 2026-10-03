import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('an administrator acts as a cashier, sees only their screens, then comes back', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/admin/utilisateurs');
  const row = page.getByRole('row', { name: /CAISSE Carl/ });
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Usurper' }).click();

  await expect(page.getByRole('heading', { name: 'Bonjour Carl' })).toBeVisible();
  await expect(page.getByRole('status').first()).toContainText('Vous agissez en tant que');
  const nav = page.getByRole('navigation', { name: 'Menu principal' });
  await expect(nav.getByRole('link', { name: 'Caisse' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Administration' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Revenir à mon compte' }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Menu principal' })
      .getByRole('link', { name: 'Administration' }),
  ).toBeVisible();
  await expect(page.getByText('Vous agissez en tant que')).toHaveCount(0);

  // The trail names the administrator and who they acted as.
  await page.goto('/admin/journal');
  await expect(page.getByText('Usurpation démarrée')).toBeVisible();
});
