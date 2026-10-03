import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('an administrator acts as a cashier from the menu, sees only their screens, then comes back', async ({
  page,
}) => {
  await login(page, USERS.admin);
  const nav = page.getByRole('navigation', { name: 'Menu principal' });
  await nav.getByRole('button', { name: 'Usurper un utilisateur' }).click();
  const dialog = page.getByRole('dialog', { name: 'Usurper un utilisateur' });
  await dialog.getByRole('searchbox', { name: 'Rechercher un utilisateur' }).fill('Carl');
  await dialog
    .getByRole('listitem')
    .filter({ hasText: 'Carl' })
    .getByRole('button', { name: 'Usurper' })
    .click();

  await expect(page.getByRole('heading', { name: 'Bonjour Carl' })).toBeVisible();
  await expect(page.getByRole('status').first()).toContainText('Vous agissez en tant que');
  await expect(nav.getByRole('link', { name: 'Caisse' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Administration' })).toHaveCount(0);

  // The menu entry stays available while acting, to go back from the popup too.
  await nav.getByRole('button', { name: 'Usurpation en cours' }).click();
  await page
    .getByRole('dialog', { name: 'Usurper un utilisateur' })
    .getByRole('button', { name: 'Revenir à mon compte' })
    .click();
  await expect(nav.getByRole('link', { name: 'Administration' })).toBeVisible();
  await expect(page.getByText('Vous agissez en tant que')).toHaveCount(0);

  // The trail names the administrator and who they acted as.
  await page.goto('/admin/journal');
  await expect(page.getByText('Usurpation démarrée')).toBeVisible();
});
