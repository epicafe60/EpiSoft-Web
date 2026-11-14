import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';
import { SEED } from '../seed';

// Audit KV2, C04: a till that went silent may hold sales that arrive after the count. Validating
// the inventory asks for a confirmation, naming the till, instead of going ahead blindly.

test.afterEach(async () => {
  await query(`delete from app.pos_device where name = 'POSTE-MUET'`);
  await query(`update app.inventory_session set status = 'CANCELLED' where status = 'OPEN'`);
});

test('an inventory is not validated blindly while a till has gone silent', async ({ page }) => {
  // A till seen 30 minutes ago, in use today: it may be selling offline.
  await query(
    `insert into app.pos_device (id, name, active, last_contact_at, pending_ops)
     values (gen_random_uuid(), 'POSTE-MUET', true, now() - interval '30 minutes', 0)`,
  );
  await login(page, USERS.admin);
  await page.goto('/appros/inventaires');
  await page.getByRole('button', { name: 'Ouvrir l’inventaire' }).click();
  await page.getByLabel('Scanner ou rechercher un produit').fill(SEED.chips.ean);
  await page.getByLabel('Scanner ou rechercher un produit').press('Enter');
  const count = page.getByRole('dialog', { name: SEED.chips.name });
  await count.getByLabel('Quantité').fill('10'); // the theoretical stock: no gap to check
  await count.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(count).toBeHidden();

  await page.getByRole('button', { name: 'Valider', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Valider l’inventaire' });
  await dialog.getByRole('button', { name: 'Valider l’inventaire' }).click();
  // Refused with the name of the till, and a way to go on knowingly.
  await expect(dialog).toContainText('POSTE-MUET');
  const anyway = dialog.getByRole('button', { name: /Valider quand même/ });
  await expect(anyway).toBeVisible();
  await anyway.click();
  await expect(dialog).toBeHidden();
  const [inv] = await query<{ status: string }>(
    `select status from app.inventory_session order by opened_at desc limit 1`,
  );
  expect(inv!.status).toBe('VALIDATED');
});
