import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { SEED } from '../seed';

test('a customer fills a cart and orders; the shop sees it (R-PRE-01)', async ({
  page,
  browser,
}) => {
  await login(page, USERS.customer);
  await page.getByRole('link', { name: 'Boutique' }).first().click();
  const card = page
    .locator('div', { hasText: SEED.honey.name })
    .filter({ has: page.getByRole('button', { name: 'Ajouter' }) })
    .last();
  await card.getByLabel(`Quantité de ${SEED.honey.name}`).fill('2');
  await card.getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.getByRole('list', { name: 'Lignes du panier' })).toContainText(SEED.honey.name);
  await expect(page.getByText('Total estimé')).toBeVisible();
  await page.getByRole('button', { name: 'Valider ma commande' }).click();
  await expect(page.getByText(/Votre commande PC-\d{4}-0001 est enregistrée/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Mes commandes' })).toContainText('Reçue');

  // The cart is empty again, and the order shows in the staff screen.
  await expect(page.getByText('Votre panier est vide.')).toBeVisible();
  const staffCtx = await browser.newContext();
  const staff = await staffCtx.newPage();
  await login(staff, USERS.admin);
  await staff.goto('/precommandes');
  await expect(staff.getByRole('link', { name: /Précommandes/ }).first()).toBeVisible();
  await expect(staff.getByRole('button', { name: /PC-\d{4}-0001/ })).toBeVisible();
  await staffCtx.close();
});
