import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query, startTill } from '../helpers';
import { SEED } from '../seed';

// Screens of the migration evolutions (docs/evols): colours, closing recap, frozen till,
// consents, order editor, supplier type-ahead.

test('R-EVO-41: the member home shows the cagnotte green, then red', async ({ page }) => {
  const [h] = await query<{ id: string }>(
    `select h.id from app.household h join app.member m on m.household_id = h.id where m.last_name = 'DUPONT'`,
  );
  await query(
    `update app.member set household_id = '${h!.id}' where username = '${USERS.customer.username}'`,
  );
  try {
    await login(page, USERS.customer);
    await page
      .getByRole('navigation', { name: 'Menu principal' })
      .getByRole('link', { name: 'Mon foyer' })
      .click();
    const balance = page.getByTestId('wallet-balance');
    await expect(page.getByText('Cagnotte approvisionnée')).toBeVisible();
    await expect(balance).toHaveClass(/text-success/);

    await query(
      `insert into app.wallet_entry (id, household_id, amount, kind) values (gen_random_uuid(), '${h!.id}', -25, 'CORRECTION')`,
    );
    await page.reload();
    await expect(page.getByText('Cagnotte à recharger')).toBeVisible();
    await expect(balance).toHaveClass(/text-destructive/);
  } finally {
    await query(
      `delete from app.wallet_entry where household_id = '${h!.id}' and kind = 'CORRECTION' and amount = -25`,
    );
    await query(
      `update app.member set household_id = null where username = '${USERS.customer.username}'`,
    );
  }
});

test('R-EVO-05: the closing shows a recap that can be corrected before anything is saved', async ({
  page,
}) => {
  await startTill(page, 'EVO6');
  await page.getByRole('link', { name: 'Clôture' }).click();
  await page.getByLabel('50 €', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Clôturer la session' }).click();
  const recap = page.getByRole('dialog', { name: 'Confirmer la clôture' });
  await expect(recap.getByText('Espèces comptées')).toBeVisible();
  await expect(recap.getByText('Fond de caisse suivant')).toBeVisible();

  const counts = () =>
    query<{ n: number }>(
      `select count(*)::int as n from app.cash_count c join app.cash_session s on s.id = c.session_id
       join app.pos_device d on d.id = s.device_id where d.name = 'EVO6'`,
    );
  await recap.getByRole('button', { name: 'Corriger le comptage' }).click();
  await expect(recap).toBeHidden();
  expect((await counts())[0]!.n).toBe(0);

  await page.getByRole('button', { name: 'Clôturer la session' }).click();
  await page
    .getByRole('dialog', { name: 'Confirmer la clôture' })
    .getByRole('button', { name: 'Confirmer la clôture' })
    .click();
  await expect(page.getByText('Session clôturée.', { exact: false })).toBeVisible();
  expect((await counts())[0]!.n).toBe(1);
});

test('R-EVO-30: a till refuses new tickets while an inventory freezes the sales', async ({
  page,
}) => {
  await query(
    `insert into app.inventory_session (id, label, scope, status, freeze_sales)
     values (gen_random_uuid(), 'E2E gel', '{}', 'OPEN', true)`,
  );
  try {
    await startTill(page, 'EVO7');
    const scan = page.getByLabel('Scanner ou rechercher un produit (F2)');
    await scan.fill(SEED.chips.ean);
    await scan.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Ventes suspendues');
    await expect(page.getByTestId('ticket-total')).toHaveText(/0,00/);
  } finally {
    await query(`update app.inventory_session set status = 'CANCELLED' where label = 'E2E gel'`);
    await query(
      `update app.cash_session set status = 'CLOSED', closed_at = now()
       where status = 'OPEN' and device_id in (select id from app.pos_device where name = 'EVO7')`,
    );
  }
});

test('R-EVO-44: the image consent is ticked on the member sheet and dated', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/membres');
  await page.getByLabel('Rechercher un membre').fill('dupont');
  await page
    .getByRole('link', { name: /DUPONT Marie|Marie DUPONT/ })
    .first()
    .click();
  await page.getByLabel('Accepte l’utilisation de son image').check();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText(/Droit à l’image accordé le/)).toBeVisible();
  const [m] = await query<{ image_consent_at: string | null }>(
    `select image_consent_at from app.member where last_name = 'DUPONT'`,
  );
  expect(m!.image_consent_at).not.toBeNull();
});

test('R-EVO-10 / R-EVO-12 / R-EVO-14: order from every reference, send by e-mail, delete a cancelled order', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/appros/commandes');
  await page.getByLabel('Nouvelle commande pour').selectOption({ label: SEED.honey.supplier });
  await page.getByRole('button', { name: 'Préparer la commande' }).click();
  await expect(page.getByRole('heading', { name: /Commande CF-/ })).toBeVisible();

  // Stock and minimum are shown next to the quantity to order.
  await expect(page.getByRole('columnheader', { name: 'Stock' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Qté commandée' })).toBeVisible();
  await expect(page.getByLabel(`Quantité ${SEED.honey.name}`)).toHaveValue('6');

  // No mail client is opened: the order leaves from the application's own e-mail account, in a
  // window where the recipient, the subject and the text can be changed (as in the previous app).
  await expect(page.getByRole('link', { name: 'Ouvrir dans ma messagerie' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Envoyer par courriel' }).click();
  const mail = page.getByRole('dialog', { name: 'Rédaction d’email' });
  await expect(mail.getByLabel('Adresse du destinataire')).toHaveValue('ferme@example.org');
  await expect(mail.getByLabel('Sujet du message')).toHaveValue(
    /^Commande CF-\d{4}-\d+ d’Épicafé de Montjavoult$/,
  );
  // « Aperçu » shows what will leave: from, to, subject, text and the order form attached.
  await mail.getByRole('button', { name: 'Aperçu' }).click();
  const shown = page.getByRole('dialog', { name: 'Aperçu du courriel' });
  await expect(shown).toContainText('ferme@example.org');
  await expect(shown).toContainText('Commande CF-');
  await expect(shown.getByText(/^CF-\d{4}-\d+\.pdf$/)).toBeVisible();
  await expect(shown.getByLabel('Corps du message')).toContainText('Veuillez trouver ci-joint');
  await shown.getByRole('button', { name: 'Modifier' }).click();
  const body = mail.getByLabel('Message', { exact: true });
  await expect(body).toHaveValue(/^Bonjour,\nVeuillez trouver ci-joint notre commande CF-/);
  const edited = 'Bonjour,\nMerci de livrer mardi matin.\n\nBien cordialement !';
  await body.fill(edited);
  await mail.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(mail).toBeHidden();
  await expect(page.getByText('Envoyée', { exact: true })).toBeVisible();
  // The mail is queued for the SMTP account, with the text as edited and the PDF attached.
  const [queued] = await query<{ to: string; text: string; attachments: { filename: string }[] }>(
    `select "to", text, attachments from app.email_outbox where subject like 'Commande CF-%' order by created_at desc limit 1`,
  );
  expect(queued!.to).toBe('ferme@example.org');
  expect(queued!.text).toBe(edited);
  expect(queued!.attachments[0]!.filename).toMatch(/^CF-.*\.pdf$/);

  // Cancel, then delete: the order is gone.
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Annuler cette commande ?' })
    .getByRole('button', { name: 'Annuler la commande' })
    .click();
  await expect(page.getByText('Annulée', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Supprimer' }).click();
  await page
    .getByRole('dialog', { name: /Supprimer la commande CF-/ })
    .getByRole('button', { name: 'Supprimer' })
    .click();
  await expect(page).toHaveURL(/\/appros\/commandes$/);
});

test('R-EVO-20: the supplier of an invoice is found by typing its first letters', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/appros/factures/nouvelle');
  await expect(page.locator(`datalist option[value="${SEED.honey.supplier}"]`)).toHaveCount(1);
  const field = page.getByPlaceholder('Premières lettres du fournisseur…');
  await field.fill(SEED.honey.supplier);
  await page.getByLabel('Total HT (€)').fill('10');
  await page.getByLabel('TVA (€)').fill('0,55');
  await expect(page.getByLabel('Total TTC')).toHaveValue(/10,55/);
});

test('R-EVO-04: at the till, the cagnotte is green while it covers the ticket, red once it does not', async ({
  page,
}) => {
  await startTill(page, 'EVO8');
  await page.getByLabel('Adhérent : nom, numéro ou badge').fill('dupont');
  await page.getByRole('option', { name: /DUPONT Marie/ }).click();
  const wallet = page.getByTestId('till-wallet');
  await expect(wallet).toHaveClass(/text-success/);
  const scan = page.getByLabel('Scanner ou rechercher un produit (F2)');
  for (let i = 0; i < 9; i++) {
    await scan.fill(SEED.chips.ean);
    await scan.press('Enter');
  }
  await expect(page.getByTestId('ticket-total')).toHaveText(/22,50/);
  await expect(wallet).toHaveClass(/text-destructive/);
  await query(
    `update app.cash_session set status = 'CLOSED', closed_at = now()
     where status = 'OPEN' and device_id in (select id from app.pos_device where name = 'EVO8')`,
  );
});

test('R-EVO-30: an inventory is opened with the sales frozen, a data check and a count sheet', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/appros/inventaires');
  await expect(page.getByText(/produit\(s\) dans le périmètre/)).toBeVisible();
  await page.getByLabel('Suspendre les ventes en caisse pendant l’inventaire').check();
  await page.getByRole('button', { name: 'Ouvrir l’inventaire' }).click();
  await expect(page.getByRole('link', { name: 'Feuille de comptage' })).toHaveAttribute(
    'href',
    /\/api\/v1\/inventories\/.+\/sheet\.xlsx$/,
  );
  const frozen = await query<{ freeze_sales: boolean }>(
    `select freeze_sales from app.inventory_session where status = 'OPEN'`,
  );
  expect(frozen).toEqual([{ freeze_sales: true }]);
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Annuler cet inventaire ?' })
    .getByRole('button', { name: 'Annuler l’inventaire' })
    .click();
  await expect(page.getByText('Annulé', { exact: true })).toBeVisible();
});
