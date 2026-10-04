import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { login, USERS } from '../fixtures';
import { SEED } from '../seed';

async function query<T>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

async function scan(page: Page, code: string) {
  const input = page.getByLabel('Scanner ou rechercher un produit (F2)');
  await input.fill(code);
  await input.press('Enter');
}

async function payAll(page: Page, method: 'Espèces' | 'Cagnotte' | 'Carte') {
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Règlement' });
  await dialog.getByRole('radio', { name: method }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await expect(dialog.getByTestId('remaining')).toHaveText(/0,00/);
  await dialog.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Ticket E2E-[0-9]+ enregistré/)).toBeVisible();
}

test('CA §4.4: the till sells offline and sends every ticket once when the network is back', async ({
  page,
  context,
}) => {
  // Other tests may have sold before: compare with the state at the start.
  const stockBefore = Number(
    (await query<{ s: string }>(`select stock_qty as s from app.product where code = '111001'`))[0]!
      .s,
  );
  await login(page, USERS.cashier);
  await page.goto('/caisse');

  // First use: declare the device, then open the session.
  await page.getByLabel('Nom du poste').fill('E2E');
  await page.getByRole('button', { name: 'Déclarer le poste' }).click();
  await page.getByLabel('Fond de caisse (€)').fill('100');
  await page.getByRole('button', { name: 'Ouvrir la session' }).click();

  // Online sale: unknown code first (never adds anything), then the real EAN.
  await scan(page, '3168930167984');
  await expect(page.getByRole('alert')).toHaveText('Code inconnu : 3168930167984');
  await scan(page, SEED.chips.ean);
  await scan(page, SEED.chips.ean);
  await expect(page.getByTestId('ticket-total')).toHaveText(/5,00/);
  await payAll(page, 'Espèces');
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 15_000 });

  // Network down (R-OFF-05 indicator).
  await context.setOffline(true);
  await expect(page.getByText('Hors ligne', { exact: true })).toBeVisible();

  // Member paying by cagnotte, estimated balance shown offline (R-OFF-04).
  await page.getByLabel('Adhérent : nom, numéro ou badge').fill('dupont');
  await page.getByRole('option', { name: /DUPONT Marie/ }).click();
  await expect(page.getByText('20,00 €')).toBeVisible();
  await scan(page, SEED.chips.ean);
  await payAll(page, 'Cagnotte');
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();

  // Weighted product from a till tab (R-VTE-04).
  await page.getByRole('tab', { name: 'Fruits' }).click();
  await page.getByRole('button', { name: new RegExp(SEED.bananas.name) }).click();
  await page.getByLabel('Quantité (kg)').fill('0,5');
  await page.getByRole('button', { name: 'Ajouter au ticket' }).click();
  await expect(page.getByTestId('ticket-total')).toHaveText(/1,60/);
  await payAll(page, 'Carte');
  await expect(page.getByText('2 en attente d’envoi')).toBeVisible();

  // Network back: everything is sent, once.
  await context.setOffline(false);
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 30_000 });

  const sales = await query<{ n: number }>(
    `select count(*)::int as n from app.sale s join app.pos_device d on d.id = s.device_id where d.name = 'E2E'`,
  );
  expect(sales[0]!.n).toBe(3);
  const balance = await query<{ balance: string }>(
    `select b.balance from app.household_balance b join app.member m on m.household_id = b.household_id where m.last_name = 'DUPONT'`,
  );
  expect(balance[0]!.balance).toBe('17.50');
  const stock = await query<{ stock_qty: string }>(
    `select stock_qty from app.product where code = '111001'`,
  );
  expect(Number(stock[0]!.stock_qty)).toBe(stockBefore - 3);

  // Tickets of the day carry their final numbers (R-SYNC-05).
  await page.getByRole('link', { name: 'Tickets du jour' }).click();
  await expect(page.getByText(/T-\d{4}-\d{6}/).first()).toBeVisible();

  // Closing (R-SES-02): 100 float + 5 cash = 105 expected.
  await page.getByRole('link', { name: 'Clôture' }).click();
  await page.getByLabel('50 €', { exact: true }).fill('2');
  await page.getByLabel('5 €', { exact: true }).fill('1');
  await expect(page.getByText('Écart')).toBeVisible();
  await page.getByRole('button', { name: 'Clôturer la session' }).click();
  await expect(page.getByText('Session clôturée.', { exact: false })).toBeVisible();
  const count = await query<{ expected_cash: string; difference: string }>(
    `select c.expected_cash, c.difference from app.cash_count c join app.cash_session s on s.id = c.session_id join app.pos_device d on d.id = s.device_id where d.name = 'E2E'`,
  );
  expect(count[0]).toEqual({ expected_cash: '105.00', difference: '0.00' });
});
