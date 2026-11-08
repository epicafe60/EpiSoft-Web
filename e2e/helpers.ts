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

/** Closes the session left open: the shop has one at a time (R-SES-05). */
export const closeAllSessions = () =>
  query(`update app.cash_session set status = 'CLOSED', closed_at = now() where status = 'OPEN'`);

/** Kept for the scenarios that name their tills: the prefix no longer matters. */
export const closeTillSessions = (_prefix?: string) => closeAllSessions();

/** The next browser page declares its till under this name (otherwise a name is generated). */
export const nameTill = (page: Page, name: string) =>
  page.addInitScript((n) => {
    (window as { __EPISOFT_DEVICE_NAME?: string }).__EPISOFT_DEVICE_NAME = n;
  }, name);

/** Signs in as the cashier, declares a till and opens the shop's session. */
export async function startTill(page: Page, device: string, float = '50') {
  await closeAllSessions();
  await nameTill(page, device);
  await login(page, USERS.cashier);
  await page.goto('/caisse');
  await page.getByLabel('Fond de caisse (€)').fill(float);
  // Another client may have opened a session since the cleanup above (the shop has one drawer:
  // the till would join it and ignore this float). Closed again just before ours is sent.
  await closeAllSessions();
  await page.getByRole('button', { name: 'Ouvrir la session' }).click();
  await expect(page.getByLabel('Scanner ou rechercher un produit (F2)')).toBeVisible();
}

/** Types a code in the till's search box and presses Enter. */
export async function scan(page: Page, code: string) {
  const input = page.getByLabel('Scanner ou rechercher un produit (F2)');
  await input.fill(code);
  await input.press('Enter');
}
