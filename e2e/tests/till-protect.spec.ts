import { expect, test, type Page } from '@playwright/test';
import { closeTillSessions, query, scan, startTill } from '../helpers';
import { SEED } from '../seed';

// Protections of the till: check before paying, a large change, a double click, a refused
// ticket entered again, a gap that has to be explained, the banners that say something waits.

const setQty = async (page: Page, qty: string) => {
  await page.getByRole('list', { name: 'Lignes du ticket' }).getByRole('button').first().click();
  const dialog = page.getByRole('dialog', { name: SEED.chips.name });
  await dialog.getByLabel('Quantité').fill(qty);
  await dialog.getByRole('button', { name: 'Valider' }).click();
};

test.beforeAll(async () => {
  // The scenarios sell anonymously.
  await query(
    `update app.setting set value = jsonb_set(value, '{requireMemberFirst}', 'false') where key = 'pos.options'`,
  );
});

// Leave nothing open: the other scenarios declare their own tills and open their own sessions.
test.afterEach(() => closeTillSessions('PROT'));

test('a ticket with an unusual quantity is checked once before it is paid', async ({ page }) => {
  await startTill(page, 'PROT1');
  await scan(page, SEED.chips.ean);
  await setQty(page, '60');
  await expect(page.getByTestId('ticket-total')).toHaveText(/150,00/);

  await page.getByRole('button', { name: 'Encaisser' }).click();
  const review = page.getByRole('dialog', { name: 'Vérifiez avant d’encaisser' });
  await expect(review.getByRole('list', { name: 'Points à vérifier' })).toContainText(
    'quantité de 60',
  );
  // « Corriger » goes back to the ticket: nothing is paid.
  await review.getByRole('button', { name: 'Corriger le ticket' }).click();
  await expect(review).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Règlement' })).toBeHidden();

  // Confirmed once: the payment opens, and asks no second time for the same ticket.
  await page.getByRole('button', { name: 'Encaisser' }).click();
  await page
    .getByRole('dialog', { name: 'Vérifiez avant d’encaisser' })
    .getByRole('button', { name: 'C’est correct, encaisser' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Règlement' })).toBeVisible();
});

test('a normal ticket goes straight to the payment', async ({ page }) => {
  await startTill(page, 'PROT2');
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  await expect(page.getByRole('dialog', { name: 'Règlement' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Vérifiez avant d’encaisser' })).toBeHidden();
});

test('a large change has to be checked before the ticket can be validated', async ({ page }) => {
  await startTill(page, 'PROT3');
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await pay.getByRole('radio', { name: 'Espèces' }).click();
  // 100 € given for 2,50 €: 97,50 € of change.
  await pay.getByLabel('Montant remis').fill('100');
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await expect(pay.getByText(/monnaie à rendre est élevée/i)).toBeVisible();
  const validate = pay.getByRole('button', { name: 'Valider le ticket' });
  await expect(validate).toBeDisabled();
  await pay.getByLabel('J’ai vérifié la somme remise et la monnaie').check();
  await expect(validate).toBeEnabled();
});

test('a double click on « Valider le ticket » makes one ticket only', async ({ page }) => {
  await startTill(page, 'PROT4');
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await pay.getByRole('radio', { name: 'Espèces' }).click();
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await pay.getByRole('button', { name: 'Valider le ticket' }).dblclick();
  await expect(page.getByText(/Ticket .* enregistré/)).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await query<{ n: number }>(
            `select count(*)::int as n from app.sale s join app.pos_device d on d.id = s.device_id where d.name = 'PROT4'`,
          )
        )[0]!.n,
      { timeout: 20_000 },
    )
    .toBe(1);
});

test('a refused ticket is flagged in the header and entered again from « Tickets du jour »', async ({
  page,
}) => {
  await startTill(page, 'PROT5');
  // The server refuses whatever is sent.
  await page.route('**/api/v1/sync/push', async (route) => {
    const body = route.request().postDataJSON() as { ops: { id: string }[] };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: body.ops.map((o) => ({
          id: o.id,
          status: 'REJECTED',
          warnings: [],
          error: 'Produit inconnu (ligne 1).',
        })),
      }),
    });
  });
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await pay.getByRole('radio', { name: 'Espèces' }).click();
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await pay.getByRole('button', { name: 'Valider le ticket' }).click();

  const flag = page.getByRole('link', { name: /1 refusé\(s\)/ });
  await expect(flag).toBeVisible({ timeout: 20_000 });
  await flag.click();
  await page
    .getByRole('button', { name: /E2E|PROT5/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: /Ticket / });
  await expect(dialog).toContainText('n’a pas été enregistré');
  await dialog.getByRole('button', { name: 'Ressaisir ce ticket' }).click();

  // Back on the sale screen, with the same lines to check and pay again.
  await expect(page.getByTestId('ticket-total')).toHaveText(/2,50/);
  await expect(page.getByRole('link', { name: /refusé\(s\)/ })).toBeHidden();
});

test('a cash gap above the threshold has to be explained before the closing', async ({ page }) => {
  await startTill(page, 'PROT6', '100');
  await page.getByRole('link', { name: 'Clôture' }).click();
  // 100 € of float, 50 € counted: 50 € missing.
  await page.getByLabel('50 €', { exact: true }).fill('1');
  await expect(page.getByText(/Il y a un écart de/)).toBeVisible();
  const submit = page.getByRole('button', { name: 'Clôturer la session' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Commentaire (obligatoire)').fill('Billets pas encore comptés');
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.getByRole('button', { name: 'Confirmer la clôture' }).click();
  await expect(page.getByText('Session clôturée.', { exact: false })).toBeVisible();
  const [row] = await query<{ comment: string }>(
    `select c.comment from app.cash_count c join app.cash_session s on s.id = c.session_id
     join app.pos_device d on d.id = s.device_id where d.name = 'PROT6'`,
  );
  expect(row!.comment).toContain('pas encore comptés');
});

test('a session left open since yesterday is pointed out above the till', async ({ page }) => {
  await startTill(page, 'PROT7');
  // The till keeps its session in IndexedDB: make it two days old, as if nobody had closed it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('episoft-till');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction('meta', 'readwrite').objectStore('meta');
          const get = store.get('session');
          get.onsuccess = () => {
            const entry = get.result as { key: string; value: { openedAt: string } };
            entry.value.openedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
            store.put(entry).onsuccess = () => resolve();
          };
        };
      }),
  );
  await page.reload();
  await expect(page.getByText(/ouverte depuis plus d’une journée/)).toBeVisible({
    timeout: 20_000,
  });
});
