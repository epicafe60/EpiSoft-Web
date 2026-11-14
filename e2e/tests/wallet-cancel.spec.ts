import { expect, test } from '@playwright/test';
import { login, USERS } from '../fixtures';
import { query } from '../helpers';

// Review of November 2026, M1: a top-up entered by mistake is cancelled the same day by an entry
// of the opposite amount. Nothing is deleted from the history of the cagnotte.

test('a top-up of the day is cancelled by a counter-entry, and the history keeps both', async ({
  page,
}) => {
  const [before] = await query<{ id: string; balance: string }>(
    `select h.id, b.balance::text from app.household h
       join app.member m on m.household_id = h.id and m.last_name = 'DUPONT'
       join app.household_balance b on b.household_id = h.id limit 1`,
  );
  // The database's own clock dates the entries: the host's may differ from the container's.
  const startedAt = (await query<{ now: string }>(`select now()::text as now`))[0]!.now;
  try {
    await login(page, USERS.admin);
    await page.goto(`/foyers/${before!.id}`);
    await page.getByRole('button', { name: 'Versement', exact: true }).click();
    const form = page.getByRole('dialog').first();
    await form.getByLabel('Montant (€)').fill('12');
    await form.getByRole('button', { name: 'Enregistrer le versement' }).click();
    // The seeded household already holds a top-up of the day: the row is the one of 12 €.
    const mine = page.getByRole('row').filter({ hasText: '12,00' });
    await expect(mine.getByRole('button', { name: 'annuler', exact: true })).toBeVisible();

    await mine.getByRole('button', { name: 'annuler', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Annuler ce versement ?' })
      .getByRole('button', { name: 'Annuler le versement' })
      .click();
    // The cancelled top-up has no « annuler » any more: it is cancelled once.
    await expect(mine.getByRole('button', { name: 'annuler', exact: true })).toHaveCount(0);

    const entries = await query<{ kind: string; amount: string; cancels: string | null }>(
      `select kind::text, amount::text, cancels_entry_id::text as cancels from app.wallet_entry
        where household_id = '${before!.id}' and created_at >= '${startedAt}' order by created_at`,
    );
    expect(entries.map((e) => `${e.kind} ${e.amount}`)).toEqual([
      'TOPUP 12.00',
      'CORRECTION -12.00',
    ]);
    expect(entries[0]!.cancels).toBeNull();
    expect(entries[1]!.cancels).not.toBeNull();
    const [pay] = await query<{ total: string; n: number }>(
      `select coalesce(sum(amount), 0)::text as total, count(*)::int as n from app.member_payment
        where household_id = '${before!.id}' and created_at >= '${startedAt}'`,
    );
    expect(pay).toEqual({ total: '0.00', n: 2 });
    const [after] = await query<{ balance: string }>(
      `select balance::text from app.household_balance where household_id = '${before!.id}'`,
    );
    expect(after!.balance).toBe(before!.balance);
  } finally {
    // The scenarios that follow rely on the seeded balance: the test data is removed (the test
    // connection owns the tables, so the history guard does not apply to it).
    await query(
      `delete from app.wallet_entry where household_id = '${before!.id}' and created_at >= '${startedAt}' and cancels_entry_id is not null`,
    );
    await query(
      `delete from app.wallet_entry where household_id = '${before!.id}' and created_at >= '${startedAt}'`,
    );
    await query(
      `delete from app.member_payment where household_id = '${before!.id}' and created_at >= '${startedAt}'`,
    );
  }
});
