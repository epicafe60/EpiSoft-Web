import { expect, test, type Page } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';

// R-ADM-06: from the journal, an administrator undoes a price change; a change made since blocks
// the undo of an older one, which the window explains.

const CSRF = { 'x-episoft-csrf': '1' };

async function setPrice(page: Page, id: string, salePrice: string) {
  const current = await (await page.request.get(`/api/v1/products/${id}`)).json();
  const res = await page.request.patch(`/api/v1/products/${id}`, {
    headers: CSRF,
    data: { updatedAt: current.updatedAt, salePrice },
  });
  expect(res.status()).toBe(200);
}

const priceOf = async (id: string) =>
  (
    await query<{ p: string }>(`select sale_price::text as p from app.product where id = '${id}'`)
  )[0]!.p;

test('the journal undoes a price change, and explains why an older one must wait', async ({
  page,
}) => {
  const [p] = await query<{ id: string }>(
    `insert into app.product (id, code, name, sale_price, stock_qty)
     values (gen_random_uuid(), '999901', 'Savon du test', 4.00, 0) returning id`,
  );
  try {
    await login(page, USERS.admin);
    await setPrice(page, p!.id, '4.80');
    await setPrice(page, p!.id, '5.20');

    await page.goto('/admin/journal');
    const rows = page.getByRole('row').filter({ hasText: 'a modifié un produit' });
    // The older change: blocked by the more recent one, which can be undone first from there.
    await rows.nth(1).getByRole('button', { name: 'Annuler…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Annuler une action' });
    await expect(dialog.getByText('Des éléments ont été modifiés depuis')).toBeVisible();
    await dialog.getByRole('button', { name: 'Annuler d’abord celle-ci' }).click();

    await expect(dialog.getByText('Remettre les valeurs d’avant')).toBeVisible();
    await dialog.getByLabel('Motif (obligatoire)').fill('prix saisi deux fois');
    await dialog.getByRole('button', { name: 'Annuler cette action' }).click();
    // Back to the first action, now possible.
    await expect(dialog.getByText('L’action la plus récente est annulée')).toBeVisible();
    await expect(dialog.getByText('Remettre les valeurs d’avant')).toBeVisible();
    expect(await priceOf(p!.id)).toBe('4.80');
    await dialog.getByLabel('Motif (obligatoire)').fill('mauvais prix');
    await dialog.getByRole('button', { name: 'Annuler cette action' }).click();
    await expect(
      dialog.getByRole('status').filter({ hasText: /^1 élément\(s\) remis comme avant\.$/ }),
    ).toBeVisible();
    expect(await priceOf(p!.id)).toBe('4.00');
    await dialog.getByRole('button', { name: 'Fermer' }).first().click();

    await expect(rows.first().getByText(/annulée le/)).toBeVisible();
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: 'a annulé une action du journal (motif : mauvais prix)' }),
    ).toBeVisible();
  } finally {
    await query(`delete from app.price_history where product_id = '${p!.id}'`);
    await query(`delete from app.product where id = '${p!.id}'`);
  }
});
