import { expect, test } from '@playwright/test';
import { closeTillSessions, query, scan, startTill } from '../helpers';
import { SEED } from '../seed';

// A device the server no longer knows (deleted, database restored): the till says so, keeps the
// sales, and declaring the device again sends them.

test.beforeAll(async () => {
  await query(
    `update app.setting set value = jsonb_set(value, '{requireMemberFirst}', 'false') where key = 'pos.options'`,
  );
});
test.afterEach(async () => {
  // The session opened under the forgotten device now belongs to the new one: no orphan is left.
  await query(
    `update app.cash_session set device_id = (select id from app.pos_device where name = 'DEVGONE')
     where not exists (select 1 from app.pos_device d where d.id = cash_session.device_id)
       and exists (select 1 from app.pos_device where name = 'DEVGONE')`,
  );
  await closeTillSessions('DEV');
});

test('a till the server forgot declares itself again and sends its sale', async ({ page }) => {
  await startTill(page, 'DEVGONE');
  // The sale is made while the till cannot reach the server: it waits in the queue.
  await page.context().setOffline(true);
  await scan(page, SEED.chips.ean);
  await page.getByRole('button', { name: 'Encaisser' }).click();
  const pay = page.getByRole('dialog', { name: 'Règlement' });
  await pay.getByRole('radio', { name: 'Espèces' }).click();
  await pay.getByLabel('Montant remis').fill('2.50');
  await pay.getByRole('button', { name: 'Ajouter' }).click();
  await pay.getByRole('button', { name: 'Valider le ticket' }).click();
  await expect(pay).toBeHidden();

  // Meanwhile the server forgets the device (a manual deletion, a restored database).
  await query(
    `set session_replication_role = replica;
     delete from app.pos_device where name = 'DEVGONE'`,
  );
  await page.context().setOffline(false);

  // The till notices it, declares itself again (its old name is free) and sends the sale: nobody
  // has to do anything.
  await expect
    .poll(
      async () =>
        (
          await query<{ name: string }>(
            `select d.name from app.sale s join app.pos_device d on d.id = s.device_id
             where s.provisional_number like 'DEVGONE-%'`,
          )
        ).map((r) => r.name),
      { timeout: 30_000 },
    )
    .toEqual(['DEVGONE']);
  await expect(page.getByRole('alert').filter({ hasText: 'ne connaît plus ce poste' })).toHaveCount(
    0,
  );
});
