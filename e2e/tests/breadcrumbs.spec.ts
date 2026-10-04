import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('form and detail pages show a trail at the top, with the way back up', async ({ page }) => {
  await login(page, USERS.admin);

  await page.goto('/catalogue/nouveau');
  const trail = page.getByRole('navigation', { name: 'Fil d’Ariane' });
  await expect(trail).toContainText('Catalogue');
  await expect(trail.getByText('Nouveau produit')).toHaveAttribute('aria-current', 'page');
  // The old button at the bottom of the form is gone.
  await expect(page.getByRole('link', { name: 'Retour au catalogue' })).toHaveCount(0);
  await trail.getByRole('link', { name: 'Catalogue' }).click();
  await expect(page).toHaveURL(/\/catalogue$/);

  await page.goto('/appros/fournisseurs/nouveau');
  const crumbs = page.getByRole('navigation', { name: 'Fil d’Ariane' });
  await expect(crumbs).toContainText('Approvisionnements');
  await crumbs.getByRole('link', { name: 'Fournisseurs' }).click();
  await expect(page).toHaveURL(/\/appros\/fournisseurs$/);

  await page.goto('/compta/ecritures/nouvelle');
  await expect(page.getByRole('navigation', { name: 'Fil d’Ariane' })).toContainText(
    'Nouvelle écriture',
  );
});
