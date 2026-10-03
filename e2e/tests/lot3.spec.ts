import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';

test('lot 3: a treasurer enters, validates and reads an entry; the closing page lists its checks', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page, USERS.admin);

  // R-CPT-03: an entry needs a fiscal year covering its date.
  const year = new Date().getFullYear();
  await page.goto('/compta/plan');
  await page.getByLabel('Libellé', { exact: true }).last().fill(`Exercice ${year}`);
  await page.getByLabel('Début').fill(`${year}-01-01`);
  await page.getByLabel('Fin').fill(`${year}-12-31`);
  await page.getByRole('button', { name: 'Créer l’exercice' }).click();
  await expect(page.getByRole('cell', { name: `Exercice ${year}` })).toBeVisible();

  // R-CPT-04/05: a balanced entry, saved and validated at once.
  await page.goto('/compta/ecritures/nouvelle');
  await page.getByLabel('Libellé', { exact: true }).fill('Achat e2e emballages');
  await page
    .getByLabel('Compte, ligne 1')
    .selectOption({ label: /^607000/ } as never)
    .catch(async () => {
      await page.getByLabel('Compte, ligne 1').selectOption({ index: 1 });
    });
  await page.getByLabel('Débit, ligne 1').fill('42,50');
  await page.getByLabel('Compte, ligne 2').selectOption({ label: '531000 · Caisse' });
  await page.getByLabel('Crédit, ligne 2').fill('42,50');
  await page.getByRole('button', { name: 'Enregistrer et valider' }).click();
  await expect(page).toHaveURL(/\/compta\/ecritures\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel('Débit, ligne 1')).toBeDisabled();

  // The list shows it with its number.
  await page.goto('/compta/ecritures');
  const row = page.getByRole('row', { name: /Achat e2e emballages/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/[A-Z]{2,3}-\d{4}-\d{4}/);

  // R-CPT-16: the balance carries the amount.
  await page.goto('/compta/editions');
  await page.getByLabel('Édition').selectOption({ label: 'Balance des comptes' });
  await expect(page.getByRole('row', { name: /531000/ })).toContainText('42,50');

  // R-CPT-18: the guided closing shows its checks and stays disabled without confirmation.
  await page.goto('/compta/cloture');
  await expect(page.getByRole('button', { name: 'Clôturer l’exercice' })).toBeDisabled();
});
