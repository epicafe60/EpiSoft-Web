import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';
import { SEED } from '../seed';

// Protections on the back-office side: « À surveiller », refused tickets, thresholds, warnings
// before a purchase price jumps, a bulk price change, an inventory, a duplicate member.

test('« À surveiller » shows a refused ticket, which can be put aside from the Surveillance page', async ({
  page,
}) => {
  await query(
    `insert into app.sync_rejection (id, op_id, kind, payload, reason)
     values (gen_random_uuid(), 'e2e-op-1', 'SALE',
       '{"total":"2.50","lines":[{"label":"Chips nature","qty":"1.000","unitPrice":"2.50"}]}',
       'Produit inconnu (ligne 1).')`,
  );
  try {
    await login(page, USERS.admin);
    const block = page.getByLabel('À surveiller');
    await expect(block).toContainText('refusé(s) par le serveur');
    // No backup was ever reported in the test database: the block says so.
    await expect(block).toContainText('Aucune sauvegarde');

    await block.getByRole('link', { name: /refusé\(s\)/ }).click();
    await expect(page.getByRole('heading', { name: 'Surveillance' })).toBeVisible();
    await expect(page.getByText('Produit inconnu (ligne 1).')).toBeVisible();
    await expect(page.getByText(/1\.000 × Chips nature/)).toBeVisible();
    await page.getByRole('button', { name: 'Classer' }).click();
    await expect(page.getByText('Aucun ticket refusé.')).toBeVisible();

    await page.getByRole('link', { name: 'Sauvegardes' }).click();
    await expect(page.getByText('Aucune sauvegarde n’a été signalée')).toBeVisible();
    await page.getByRole('link', { name: 'Erreurs du serveur' }).click();
    await expect(page.getByText('Aucune erreur enregistrée.')).toBeVisible();
    await page.getByRole('link', { name: 'Courriels' }).click();
    await expect(page.getByText('Aucun courriel en échec.')).toBeVisible();
  } finally {
    await query(`delete from app.sync_rejection where op_id = 'e2e-op-1'`);
  }
});

test('a cashier does not see « À surveiller » nor the Surveillance page', async ({ page }) => {
  await login(page, USERS.cashier);
  await expect(page.getByLabel('À surveiller')).toHaveCount(0);
  await page.goto('/surveillance');
  await expect(page).toHaveURL(/\/$/);
});

test('the alert thresholds can be changed and put back to their defaults', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/admin/parametres');
  const qty = page.getByLabel('Quantité d’une ligne de ticket (unités)');
  const card = page.locator('form').filter({ has: qty });
  await expect(qty).toHaveValue('50');
  await qty.fill('7');
  await card.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(card.getByText('Enregistré.')).toBeVisible();
  await page.reload();
  await expect(qty).toHaveValue('7');
  await card.getByRole('button', { name: 'Remettre les valeurs par défaut' }).click();
  await expect(qty).toHaveValue('50');
  await card.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(card.getByText('Enregistré.')).toBeVisible();
});

test('a new product is checked against an almost identical name and a price below cost', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/catalogue/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill('chips nature');
  await expect(page.getByText('Un produit au nom très proche existe déjà')).toBeVisible();
  await page.getByLabel('PA HT (€)').fill('10');
  await page.getByLabel('Prix de vente TTC (€)').fill('4');
  await expect(page.getByText('Le prix de vente est inférieur au prix d’achat')).toBeVisible();
  await page.getByLabel('Prix de vente TTC (€)').fill('20');
  await expect(page.getByText('Le prix de vente est inférieur au prix d’achat')).toBeHidden();
});

test('a bulk price change shows what it will do before it is applied', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/catalogue/prix');
  await page.getByLabel('Fournisseur').selectOption({ label: SEED.honey.supplier });
  const row = page.locator('tr', { hasText: SEED.honey.name });
  await row.locator('input').nth(1).fill('2'); // the selling price: 8 € → 2 €
  await page.getByRole('button', { name: /Valider \d+ modification/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Appliquer ces prix ?' });
  await expect(confirm.getByRole('list', { name: 'Conséquences' })).toContainText('1 produit(s)');
  await expect(confirm.getByRole('list', { name: 'Conséquences' })).toContainText(
    'moins cher que leur prix d’achat',
  );
  // Cancelled: nothing changed.
  await confirm.getByRole('button', { name: 'Annuler' }).click();
  const [p] = await query<{ sale_price: string }>(
    `select sale_price from app.product where code = '${SEED.honey.code}'`,
  );
  expect(p!.sale_price).toBe('8.00');
});

test('an inventory with a gap far from the theory has to be checked before it is validated', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/appros/inventaires');
  await page.getByRole('button', { name: 'Ouvrir l’inventaire' }).click();
  await page.getByLabel('Scanner ou rechercher un produit').fill(SEED.chips.ean);
  await page.getByLabel('Scanner ou rechercher un produit').press('Enter');
  const count = page.getByRole('dialog', { name: SEED.chips.name });
  await count.getByLabel('Quantité').fill('0'); // far from the theoretical stock
  await count.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(count).toBeHidden();
  await page.getByRole('button', { name: 'Valider', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Valider l’inventaire' });
  await expect(dialog).toContainText('très loin de leur stock théorique');
  const validate = dialog.getByRole('button', { name: 'Valider l’inventaire' });
  await expect(validate).toBeDisabled();
  await dialog.getByLabel('J’ai recompté ces produits').check();
  await expect(validate).toBeEnabled();
  // Not validated: the inventory is cancelled, the stock is untouched.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Annuler cet inventaire ?' })
    .getByRole('button', { name: 'Annuler l’inventaire' })
    .click();
  await expect(page.getByText('Annulé', { exact: true })).toBeVisible();
});

test('a member card warns about a person who already has one, and about a mistyped address', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/membres/nouveau');
  await page.getByLabel('Nom', { exact: true }).fill('dupont');
  await page.getByLabel('Prénom').fill('MARIE');
  await expect(page.getByText('a peut-être déjà une fiche')).toBeVisible();
  await expect(page.getByRole('link', { name: /DUPONT Marie/ })).toBeVisible();

  await page.getByRole('textbox', { name: 'Courriel' }).fill('marie@gmial.com');
  await expect(page.getByText('marie@gmail.com')).toBeVisible();
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(page.getByRole('textbox', { name: 'Courriel' })).toHaveValue('marie@gmail.com');
});

test('a large top-up has to be confirmed with its consequence', async ({ page }) => {
  await login(page, USERS.admin);
  await page.goto('/membres');
  await page.getByLabel('Rechercher un membre').fill('dupont');
  await page
    .getByRole('link', { name: /DUPONT Marie|Marie DUPONT/ })
    .first()
    .click();
  await page.getByRole('link', { name: /Voir le foyer/ }).click();
  await page.getByRole('button', { name: 'Versement', exact: true }).click();
  const form = page.getByRole('dialog').first();
  await form.getByLabel('Montant (€)').fill('250');
  await form.getByRole('button', { name: 'Enregistrer le versement' }).click();
  const confirm = page.getByRole('dialog', { name: 'Gros versement : vérifiez le montant' });
  await expect(confirm.getByRole('list', { name: 'Conséquences' })).toContainText('Nouveau solde');
  await confirm.getByRole('button', { name: 'Annuler' }).click();
  const [n] = await query<{ n: number }>(
    `select count(*)::int as n from app.wallet_entry where amount = 250`,
  );
  expect(n!.n).toBe(0);
});

test('receiving goods flags a purchase price that jumped and asks to check the delivery note', async ({
  page,
}) => {
  await login(page, USERS.admin);
  await page.goto('/appros/commandes');
  await page.getByLabel('Nouvelle commande pour').selectOption({ label: SEED.honey.supplier });
  await page.getByRole('button', { name: 'Préparer la commande' }).click();
  await expect(page.getByRole('heading', { name: /Commande CF-/ })).toBeVisible();
  await page.getByRole('button', { name: 'Réceptionner' }).click();
  const receive = page.getByRole('dialog', { name: /Réception/ });
  // 5 € → 9 € HT: +80 %.
  await receive.getByLabel(`PA HT ${SEED.honey.name}`).fill('9');
  await expect(receive.getByText(/Prix d’achat 5 € → 9 €/)).toBeVisible();
  const validate = receive.getByRole('button', { name: 'Valider la réception' });
  await expect(validate).toBeDisabled();
  await receive.getByLabel('J’ai vérifié les prix et les quantités').check();
  await expect(validate).toBeEnabled();
  // Back to the price of the order: no warning, no check needed.
  await receive.getByLabel(`PA HT ${SEED.honey.name}`).fill('5');
  await expect(receive.getByText(/Prix d’achat 5 € → /)).toBeHidden();
  await expect(validate).toBeEnabled();
  // Leave nothing behind: close the window, cancel and delete the draft order.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Annuler cette commande ?' })
    .getByRole('button', { name: 'Annuler la commande' })
    .click();
  await page.getByRole('button', { name: 'Supprimer' }).click();
  await page
    .getByRole('dialog', { name: /Supprimer la commande CF-/ })
    .getByRole('button', { name: 'Supprimer' })
    .click();
});
