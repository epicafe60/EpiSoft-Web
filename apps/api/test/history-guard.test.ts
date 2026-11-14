import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sale, stockMovement } from '@episoft/db';
import { refusedToAppRole, setupTestApp } from './helpers';
import { addProduct, openTill, type Till } from './till-fixtures';

// Review of November 2026 (M1): the history of the till is added to, never rewritten, and what
// the application may still change on a ticket is named. Run with the application's own role.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});
// A refused operation alerts the administrators in the background: wait until the database is idle.
afterEach(async () => {
  await expect
    .poll(
      async () =>
        (
          await t.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity
                where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`,
          )
        ).rows[0]!.n,
      { timeout: 5000 },
    )
    .toBe(0);
});

async function soldTicket() {
  const p = await addProduct(t.db);
  const op = till.saleOp([{ productId: p.id, unitPrice: '2.50' }], '2.50');
  expect((await till.push([op]))[0]!.status).toBe('OK');
  return { id: op.id, productId: p.id };
}

describe('a ticket and its lines, payments and stock movements cannot be rewritten', () => {
  it('refuses to delete them or to change an amount, a quantity or a date', async () => {
    const { id } = await soldTicket();
    const refused = '23000';
    expect(await refusedToAppRole(sql`delete from app.sale where id = ${id}`)).toBe(refused);
    expect(await refusedToAppRole(sql`update app.sale set total = '0.01' where id = ${id}`)).toBe(
      refused,
    );
    expect(
      await refusedToAppRole(
        sql`update app.sale set sold_at = now() - interval '9 days' where id = ${id}`,
      ),
    ).toBe(refused);
    expect(
      await refusedToAppRole(sql`update app.sale set cashier_id = null where id = ${id}`),
    ).toBe(refused);
    expect(await refusedToAppRole(sql`delete from app.sale_line where sale_id = ${id}`)).toBe(
      refused,
    );
    expect(
      await refusedToAppRole(
        sql`update app.sale_line set qty = 9, line_total = 22.50 where sale_id = ${id}`,
      ),
    ).toBe(refused);
    expect(await refusedToAppRole(sql`delete from app.sale_payment where sale_id = ${id}`)).toBe(
      refused,
    );
    expect(
      await refusedToAppRole(
        sql`update app.sale_payment set method = 'CARD' where sale_id = ${id}`,
      ),
    ).toBe(refused);
    expect(await refusedToAppRole(sql`delete from app.stock_movement`)).toBe(refused);
    expect(await refusedToAppRole(sql`update app.stock_movement set qty = 100`)).toBe(refused);
  });

  it('still lets the application change the state of a ticket and what is said about it', async () => {
    const { id } = await soldTicket();
    // Cancelled, reviewed, e-mailed, warned: the columns a ticket legitimately changes.
    expect(
      await refusedToAppRole(sql`update app.sale set status = 'CANCELLED' where id = ${id}`),
    ).toBeNull();
    expect(
      await refusedToAppRole(
        sql`update app.sale set warnings_reviewed_at = now() where id = ${id}`,
      ),
    ).toBeNull();
    expect(
      await refusedToAppRole(sql`update app.sale set email_sent_at = now() where id = ${id}`),
    ).toBeNull();
    expect(
      await refusedToAppRole(sql`update app.sale set warnings = '[]'::jsonb where id = ${id}`),
    ).toBeNull();
  });

  it('lets the application add to the history, which is what it is for', async () => {
    const { productId } = await soldTicket();
    expect(
      await refusedToAppRole(
        sql`insert into app.stock_movement (id, product_id, qty, kind) values (gen_random_uuid(), ${productId}, 1, 'CORRECTION')`,
      ),
    ).toBeNull();
  });

  it('does not stand in the way of the owner of the tables (migrations, restore, repair)', async () => {
    const { id, productId } = await soldTicket();
    // The test connection owns the tables, like the owner role after the split of the roles.
    await t.db.execute(sql`update app.sale set discount_total = discount_total where id = ${id}`);
    await t.db.execute(
      sql`update app.stock_movement set comment = 'x' where product_id = ${productId}`,
    );
    expect((await t.db.select().from(sale).where(eq(sale.id, id)))[0]!.id).toBe(id);
    expect(
      (await t.db.select().from(stockMovement).where(eq(stockMovement.productId, productId)))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('the float of a drawer', () => {
  it('is never negative in the database', async () => {
    expect(
      await refusedToAppRole(
        sql`insert into app.cash_session (id, device_id, opened_at, opening_float) values (${randomUUID()}, ${till.deviceId}, now(), -1)`,
      ),
    ).toBe('23514');
  });
});
