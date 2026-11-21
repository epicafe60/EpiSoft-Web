import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

// ADR 0016: the screen of the closings of period (« Z »), the control of the journal and the archive.

test('the closings, the control of the journal and the archive of a controller', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/compta');
  await page.getByRole('link', { name: 'Clôtures Z' }).click();
  await expect(page).toHaveURL(/\/compta\/clotures-z$/);
  await expect(page).toHaveTitle(/Clôtures Z/);

  // What is left to close, and the closings made.
  await expect(page.getByRole('heading', { name: 'À clôturer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clôtures faites' })).toBeVisible();

  // The control recomputes the chain and says the journal is intact.
  await page.getByRole('button', { name: 'Lancer le contrôle' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Journal intact' })).toBeVisible();

  // The archive of the year is downloadable, and a file of it is verified by the server.
  const year = new Date().getFullYear();
  await page.getByLabel('Du', { exact: true }).fill(`${year}-01-01`);
  const link = page.getByRole('link', { name: 'Télécharger l’archive' });
  await expect(link).toHaveAttribute(
    'href',
    /\/admin\/fiscal\/archive\?from=\d{4}-01-01&to=\d{4}-\d{2}-\d{2}/,
  );
  const res = await page.request.get((await link.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  await page.getByLabel('Vérifier un fichier d’archive').setInputFiles({
    name: 'archive.json',
    mimeType: 'application/json',
    buffer: Buffer.from(await res.body()),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Archive conforme' })).toBeVisible();

  // A file that is not an archive is said so.
  await page.getByLabel('Vérifier un fichier d’archive').setInputFiles({
    name: 'autre.json',
    mimeType: 'application/json',
    buffer: Buffer.from('pas du json'),
  });
  await expect(page.getByText('Ce fichier n’est pas une archive fiscale')).toBeVisible();
});

test('a cashier does not reach the closings', async ({ page }) => {
  await login(page, USERS.cashier);
  await page.goto('/compta/clotures-z');
  await expect(page).toHaveURL(/\/$/); // sent back to the home page
});
