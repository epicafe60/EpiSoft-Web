import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { login, USERS } from './fixtures';

// Helpers shared by the scenarios: database reads and fixes, and the usual till gestures.

/** A query on the test database (the scenarios check what the screens wrote). */
export async function query<T>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

/** The rule « a member or a passing membership before the first line » on or off. */
export const setMemberFirst = (on: boolean) =>
  query(
    `update app.setting set value = jsonb_set(value, '{requireMemberFirst}', '${on}') where key = 'pos.options'`,
  );

/** Closes the sessions left open by the tills whose name starts with `prefix`. */
export const closeTillSessions = (prefix: string) =>
  query(
    `update app.cash_session set status = 'CLOSED', closed_at = now()
     where status = 'OPEN' and device_id in (select id from app.pos_device where name like '${prefix}%')`,
  );

/** Signs in as the cashier, declares a till and opens its session. */
export async function startTill(page: Page, device: string, float = '50') {
  await login(page, USERS.cashier);
  await page.goto('/caisse');
  await page.getByLabel('Nom du poste').fill(device);
  await page.getByRole('button', { name: 'Déclarer le poste' }).click();
  await page.getByLabel('Fond de caisse (€)').fill(float);
  await page.getByRole('button', { name: 'Ouvrir la session' }).click();
  await expect(page.getByLabel('Scanner ou rechercher un produit (F2)')).toBeVisible();
}

/** Types a code in the till's search box and presses Enter. */
export async function scan(page: Page, code: string) {
  const input = page.getByLabel('Scanner ou rechercher un produit (F2)');
  await input.fill(code);
  await input.press('Enter');
}
