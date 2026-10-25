import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { closeAllSessions, nameTill } from '../helpers';
import { PREVIEW_PORT } from '../playwright.config';
import { SEED } from '../seed';

// Runs on the production build: only it has the service worker that caches the app.
test.use({ baseURL: `http://localhost:${PREVIEW_PORT}` });

test('R-OFF-01 / R-OFF-06: the till reloads, keeps its ticket and sells with no network', async ({
  page,
  context,
}) => {
  await closeAllSessions();
  await nameTill(page, 'HORSLIGNE');
  await login(page, USERS.cashier);
  await page.goto('/caisse');
  await page.getByLabel('Fond de caisse (€)').fill('50');
  await page.getByRole('button', { name: 'Ouvrir la session' }).click();
  const scanInput = page.getByLabel('Scanner ou rechercher un produit (F2)');
  await expect(scanInput).toBeVisible();

  // Wait until the service worker controls the page.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 15_000 });

  // No network at all: the page reloads from the cache, with its data.
  await context.setOffline(true);
  await page.reload();
  await expect(scanInput).toBeVisible();
  await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();

  await scanInput.fill(SEED.chips.ean);
  await scanInput.press('Enter');
  await expect(page.getByTestId('ticket-total')).toHaveText(/2,50/);

  // A ticket in progress survives a reload (R-OFF-06).
  await page.reload();
  await expect(page.getByTestId('ticket-total')).toHaveText(/2,50/);

  await page.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Règlement' });
  await dialog.getByRole('radio', { name: 'Espèces' }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await dialog.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page.getByText(/Ticket HORSLIGNE-[0-9]+ enregistré/)).toBeVisible();
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();

  // The outbox survives a reload too, and is sent when the network is back.
  await page.reload();
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 30_000 });
});
