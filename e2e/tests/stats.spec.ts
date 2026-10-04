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

test('trend chart, saved report and import wizard (R-STA-03/05, R-IMP-01)', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/stats');
  await page.getByRole('tab', { name: 'Tendance du CA' }).click();
  await expect(page.getByLabel('Pas', { exact: true })).toBeVisible();

  // A saved report can be stored then reopened.
  const name = `Rapport ${Date.now()}`;
  await page.getByLabel('Nom du rapport').fill(name);
  await page.getByRole('button', { name: 'Enregistrer ces filtres' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible();

  // Import: preview then apply a product file (free format with headers).
  await page.goto('/imports');
  await page.getByLabel('Format du fichier').selectOption('custom');
  const code = `E2E${Date.now()}`;
  await page.getByLabel(/Fichier \(/).setInputFiles({
    name: 'produits.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Code;Nom;Prix de vente\n${code};Produit import;4,20\n`),
  });
  await page.getByRole('button', { name: 'Aperçu' }).click();
  await expect(page.getByText('1 à créer')).toBeVisible();
  await page.getByRole('button', { name: "Appliquer l'import" }).click();
  await expect(page.getByText(/Import terminé : 1 créé/)).toBeVisible();
});

test('the administrator sees the automated integrity checks', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/controles');
  await expect(page.getByRole('list', { name: 'Contrôles' })).toContainText('STK-01');
  await expect(page.getByText('Aucune anomalie de calcul')).toBeVisible();
});
