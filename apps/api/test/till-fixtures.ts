import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { product, stockMovement, type Db } from '@episoft/db';
import type { SyncOp } from '@episoft/shared';
import { createUser, login, type setupTestApp } from './helpers';

// A till ready to sell, shared by the tests that push operations: a cashier, an administrator,
// a declared device and an open session (100 € of float).

type App = Awaited<ReturnType<typeof setupTestApp>>;
type Headers = Record<string, string>;

export interface PushResult {
  id: string;
  status: string;
  error?: string;
  warnings: { code: string; message: string }[];
}

export interface SaleLineInput {
  productId: string;
  qty?: string;
  unitPrice: string;
  catalogPrice?: string;
  discount?: string;
}

export interface Till {
  cashier: Headers;
  admin: Headers;
  cashierId: string;
  /** « Prénom NOM », as the screens say it. */
  cashierName: string;
  deviceId: string;
  sessionId: string;
  /** The next device sequence number (operations are numbered by the till). */
  nextSeq(): number;
  /** Pushes operations as the till; any HTTP answer other than 200 throws. */
  push(ops: SyncOp[]): Promise<PushResult[]>;
  /** A cash sale of the lines, paid exactly. */
  saleOp(lines: SaleLineInput[], paid: string, soldAt?: Date): SyncOp;
}

/** Empties what the till tests write, keeping the seeded service products. */
export async function resetTill(db: Db): Promise<void> {
  // job_run holds the « one alert per hour » slots: a slot left by another test would mute an alert.
  await db.execute(sql`truncate app.sync_rejection, app.integrity_run, app.error_log, app.backup_run,
    app.job_run, app.wallet_snapshot, app.invoice_receipt, app.supplier_invoice, app.goods_receipt_line,
    app.goods_receipt, app.preorder_line, app.preorder, app.sync_receipt, app.sale_payment,
    app.sale_line, app.membership, app.wallet_entry, app.member_payment, app.sale, app.cash_count,
    app.cash_session, app.pos_device, app.stock_movement, app.product_barcode, app.price_history,
    app.number_counter cascade`);
  await db.execute(sql`delete from app.product where code not in ('01001', '01002', '01004')`);
  await db.execute(sql`delete from app.supplier`);
}

/** A product with its opening stock recorded as a movement, like the application does. */
export async function addProduct(db: Db, over: Partial<typeof product.$inferInsert> = {}) {
  const [p] = await db
    .insert(product)
    .values({
      code: String(100000 + Math.floor(Math.random() * 899999)),
      name: 'Lentilles',
      salePrice: '2.50',
      stockQty: '10',
      ...over,
    })
    .returning();
  if (Number(p!.stockQty) !== 0)
    await db.insert(stockMovement).values({ productId: p!.id, qty: p!.stockQty, kind: 'INITIAL' });
  return p!;
}

/** Resets the data, then declares a till and opens its session. */
export async function openTill(t: App): Promise<Till> {
  await t.reset();
  await resetTill(t.db);
  const c = await createUser(t.db, { roles: ['CAISSE'] });
  const cashier = await login(t.app, c.username!);
  const admin = await login(t.app, (await createUser(t.db, { roles: ['ADMIN'] })).username!);
  const deviceId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/pos/devices',
      headers: cashier,
      payload: { name: 'CAISSE1' },
    })
  ).json().id as string;
  const sessionId = randomUUID();
  let seq = 1;

  const push = async (ops: SyncOp[]) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: cashier,
      payload: { deviceId, ops },
    });
    if (res.statusCode !== 200) throw new Error(`push ${res.statusCode}: ${res.body}`);
    return res.json().results as PushResult[];
  };

  const till: Till = {
    cashier,
    admin,
    cashierId: c.id,
    cashierName: `${c.firstName} ${c.lastName}`,
    deviceId,
    sessionId,
    nextSeq: () => ++seq,
    push,
    saleOp(lines, paid, soldAt = new Date()) {
      const n = ++seq;
      const total = lines.reduce(
        (s, l) =>
          s +
          Math.round(Number(l.qty ?? '1') * Number(l.unitPrice) * 100) -
          Math.round(Number(l.discount ?? '0') * 100),
        0,
      );
      return {
        kind: 'SALE',
        id: randomUUID(),
        deviceSeq: n,
        payload: {
          sessionId,
          cashierId: c.id,
          memberId: null,
          soldAt: soldAt.toISOString(),
          provisionalNumber: `CAISSE1-${n}`,
          lines: lines.map((l) => ({
            productId: l.productId,
            label: 'Article',
            qty: l.qty ?? '1',
            unitPrice: l.unitPrice,
            catalogPrice: l.catalogPrice ?? l.unitPrice,
            discount: l.discount ?? '0',
          })),
          payments: [{ method: 'CASH', amount: paid }] as never,
          total: (total / 100).toFixed(2),
          emailReceipt: false,
          walletOverdraftForcedBy: null,
        },
      };
    },
  };

  await push([
    {
      kind: 'SESSION_OPEN',
      id: sessionId,
      deviceSeq: 1,
      payload: {
        sessionId,
        openedBy: c.id,
        openedAt: new Date().toISOString(),
        openingFloat: '100.00',
      },
    },
  ]);
  return till;
}
