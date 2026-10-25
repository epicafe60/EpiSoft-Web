import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { login, USERS } from '../fixtures';
import { closeAllSessions, nameTill } from '../helpers';
import { PREVIEW_PORT } from '../playwright.config';
import { SEED } from '../seed';

// Offline scenarios beyond the main one (till.spec.ts, till-offline-reload.spec.ts):
// retries, closing with a queue, estimated balance ceiling, top-up, back-office message,
// a queue that survives closing the page. Production build: only it has the service worker.
test.use({ baseURL: `http://localhost:${PREVIEW_PORT}` });

async function query<T>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Declares a till, opens its session, and waits until the service worker controls the page. */
async function startTill(page: Page, device: string) {
  await closeAllSessions();
  await nameTill(page, device);
  await login(page, USERS.cashier);
  await page.goto('/caisse');
  await page.getByLabel('Fond de caisse (€)').fill('50');
  await page.getByRole('button', { name: 'Ouvrir la session' }).click();
  await expect(page.getByLabel('Scanner ou rechercher un produit (F2)')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 15_000 });
}

async function scan(page: Page, code: string) {
  const input = page.getByLabel('Scanner ou rechercher un produit (F2)');
  await input.fill(code);
  await input.press('Enter');
}

async function payCash(page: Page) {
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Règlement' });
  await dialog.getByRole('radio', { name: 'Espèces' }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await dialog.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(dialog).toBeHidden();
}

async function salesOf(device: string): Promise<number> {
  return (
    await query<{ n: number }>(
      `select count(*)::int as n from app.sale s join app.pos_device d on d.id = s.device_id where d.name = '${device}'`,
    )
  )[0]!.n;
}

const offline = (context: BrowserContext) => context.setOffline(true);
const online = (context: BrowserContext) => context.setOffline(false);

test('R-OFF-03: a server that fails keeps the ticket queued, retries, and the ticket arrives once', async ({
  page,
  context,
}) => {
  await startTill(page, 'RETRY');
  await offline(context);
  await scan(page, SEED.chips.ean);
  await payCash(page);
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();

  // The network is back but the server answers 503 twice: the ticket must stay queued.
  let calls = 0;
  await page.route('**/api/v1/sync/push', async (route) => {
    calls++;
    if (calls <= 2) await route.fulfill({ status: 503, body: 'indisponible' });
    else await route.continue();
  });
  await online(context);
  await expect.poll(() => calls, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();
  expect(await salesOf('RETRY')).toBe(0);

  // Exponential back-off (2 s then 4 s): the third attempt goes through.
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 30_000 });
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(await salesOf('RETRY')).toBe(1);
});

test('R-OFF-06: the queue survives closing the page, and is sent from a fresh page', async ({
  page,
  context,
}) => {
  await startTill(page, 'REOPEN');
  await offline(context);
  await scan(page, SEED.chips.ean);
  await payCash(page);
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();
  await page.close();

  const fresh = await context.newPage();
  await fresh.goto('/caisse');
  await expect(fresh.getByText('1 en attente d’envoi')).toBeVisible();
  expect(await salesOf('REOPEN')).toBe(0);

  await online(context);
  await expect(fresh.getByText('Tout est envoyé')).toBeVisible({ timeout: 30_000 });
  expect(await salesOf('REOPEN')).toBe(1);
});

test('R-OFF-04: offline, a cagnotte payment above the estimated balance is refused', async ({
  page,
  context,
}) => {
  await startTill(page, 'PLAFOND');
  await offline(context);
  await page.getByLabel('Adhérent : nom, numéro ou badge').fill('dupont');
  await page.getByRole('option', { name: /DUPONT Marie/ }).click();
  // 12 × 2,50 € = 30 €, far above any balance the seed or other tests leave.
  for (let i = 0; i < 12; i++) await scan(page, SEED.chips.ean);
  await expect(page.getByTestId('ticket-total')).toHaveText(/30,00/);

  await page.getByRole('button', { name: 'Encaisser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Règlement' });
  await dialog.getByRole('radio', { name: 'Cagnotte' }).click();
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await expect(dialog.getByText(/Solde de cagnotte insuffisant/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Valider le ticket' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Tout est envoyé')).toBeVisible();
  await online(context);
  expect(await salesOf('PLAFOND')).toBe(0);
});

test('R-OFF-03: a cagnotte top-up made offline is queued, then recorded once', async ({
  page,
  context,
}) => {
  await startTill(page, 'VERSEMENT');
  const startedAt = (await query<{ t: string }>('select now()::text as t'))[0]!.t;
  const before = await query<{ balance: string }>(
    `select b.balance from app.household_balance b join app.member m on m.household_id = b.household_id where m.last_name = 'DUPONT'`,
  );
  await offline(context);
  await page.getByLabel('Adhérent : nom, numéro ou badge').fill('dupont');
  await page.getByRole('option', { name: /DUPONT Marie/ }).click();
  await page.getByRole('button', { name: 'Versement sur la cagnotte' }).click();
  const dialog = page.getByRole('dialog', { name: 'Versement sur la cagnotte' });
  await dialog.getByLabel('Montant (€)').fill('10');
  await dialog.getByRole('button', { name: 'Enregistrer le versement' }).click();
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();

  await online(context);
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 30_000 });
  const after = await query<{ balance: string }>(
    `select b.balance from app.household_balance b join app.member m on m.household_id = b.household_id where m.last_name = 'DUPONT'`,
  );
  expect(Number(after[0]!.balance)).toBeCloseTo(Number(before[0]!.balance) + 10, 2);

  // The e2e database is shared: put the household back as other tests expect it.
  await query(
    `delete from app.wallet_entry where payment_id in (select id from app.member_payment where created_at >= '${startedAt}')`,
  );
  await query(`delete from app.member_payment where created_at >= '${startedAt}'`);
});

test('R-OFF-07: the closing screen warns about unsent operations, says it needs the network, and the warning lifts once they are sent', async ({
  page,
  context,
}) => {
  await startTill(page, 'CLOTURE');
  await offline(context);
  await scan(page, SEED.chips.ean);
  await payCash(page);
  await expect(page.getByText('1 en attente d’envoi')).toBeVisible();

  await page.getByRole('link', { name: 'Clôture' }).click();
  await expect(
    page.getByText(/1 opération\(s\) de ce poste ne sont pas encore envoyées/),
  ).toBeVisible();
  await expect(page.getByText('La clôture nécessite le réseau')).toBeVisible();

  // Back online the queue empties by itself and the warning goes away.
  await online(context);
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/ne sont pas encore envoyées/)).toBeHidden();
  expect(await salesOf('CLOTURE')).toBe(1);
});

test('R-OFF-08: a back-office page opened offline says clearly that it needs the network', async ({
  page,
  context,
}) => {
  await startTill(page, 'BACKOFFICE');
  await offline(context);
  await page.goto('/mon-foyer');
  await expect(page.getByText(/serveur est injoignable/i)).toBeVisible();
  await online(context);
});
