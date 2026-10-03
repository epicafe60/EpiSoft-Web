import { expect, test } from '@playwright/test';
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

test('lot 2 end criterion: order → receipt → sale → inventory, consistent stock', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, USERS.admin);

  // Order: prefilled with the product under its minimum stock (R-CMD-01).
  await page.goto('/appros/commandes');
  await page.getByLabel('Nouvelle commande pour').selectOption({ label: SEED.honey.supplier });
  await page.getByRole('button', { name: 'Préparer la commande' }).click();
  await expect(page.getByRole('heading', { name: /Commande CF-/ })).toBeVisible();
  await expect(page.getByLabel(`Quantité ${SEED.honey.name}`)).toHaveValue('6');

  // Receipt of the 6 expected (R-CMD-05).
  await page.getByRole('button', { name: 'Réceptionner' }).click();
  const receive = page.getByRole('dialog', { name: /Réception/ });
  await expect(receive.getByLabel(`Quantité reçue ${SEED.honey.name}`)).toHaveValue('6');
  await receive.getByRole('button', { name: 'Valider la réception' }).click();
  await expect(receive).toBeHidden();
  await expect(page.getByText('Reçue', { exact: true })).toBeVisible();

  // Sale of 1 at the till.
  await page.goto('/caisse');
  await page.getByLabel('Nom du poste').fill('CYCLE');
  await page.getByRole('button', { name: 'Déclarer le poste' }).click();
  await page.getByLabel('Fond de caisse (€)').fill('0');
  await page.getByRole('button', { name: 'Ouvrir la session' }).click();
  const scan = page.getByLabel('Scanner ou rechercher un produit (F2)');
  await scan.fill(SEED.honey.code);
  await scan.press('Enter');
  await expect(page.getByTestId('ticket-total')).toHaveText(/8,00/);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await pay.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(page.getByText('Tout est envoyé')).toBeVisible({ timeout: 15_000 });

  // Inventory of the supplier's products: 4 counted for 5 expected (R-STK-04).
  await page.goto('/appros/inventaires');
  await page.getByLabel('Périmètre').selectOption('supplier');
  await page.getByLabel('Fournisseur').selectOption({ label: SEED.honey.supplier });
  await page.getByRole('button', { name: 'Ouvrir l’inventaire' }).click();
  await page.getByLabel('Scanner ou rechercher un produit').fill(SEED.honey.code);
  await page.getByLabel('Scanner ou rechercher un produit').press('Enter');
  const countDialog = page.getByRole('dialog', { name: SEED.honey.name });
  await countDialog.getByLabel('Quantité').fill('4');
  await countDialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(countDialog).toBeHidden();
  await page.getByRole('button', { name: 'Valider' }).click();
  await page.getByRole('dialog', { name: 'Valider l’inventaire' }).getByRole('button', { name: 'Valider l’inventaire' }).click();
  await expect(page.getByRole('heading', { name: 'Rapport d’écarts' })).toBeVisible();

  // The ledger explains the stock: +6 received, −1 sold, −1 inventory = 4.
  const rows = await query<{ kind: string; qty: string }>(
    `select m.kind, m.qty from app.stock_movement m join app.product p on p.id = m.product_id where p.code = '${SEED.honey.code}' order by m.at`,
  );
  expect(rows).toEqual([
    { kind: 'PURCHASE_IN', qty: '6.000' },
    { kind: 'SALE', qty: '-1.000' },
    { kind: 'INVENTORY', qty: '-1.000' },
  ]);
  const [p] = await query<{ stock_qty: string }>(`select stock_qty from app.product where code = '${SEED.honey.code}'`);
  expect(p!.stock_qty).toBe('4.000');
});
