import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  registerNumber,
  sealOp,
  verifyArchive,
  type FiscalArchive,
  type SealedOp,
  type SyncOp,
} from '@episoft/shared';
import { configureFiscal } from '../src/modules/fiscal/journal';
import { autoCloseDays } from '../src/modules/fiscal/routes';
import { refusedToAppRole, setupTestApp } from './helpers';
import { expectIntegrity } from './integrity-helper';
import { addProduct, openTill, type Till } from './till-fixtures';

// ADR 0016: the inalterable till. Seal of the till (offline), chained journal, closings, credit
// notes, duplicata, archive, and the tamper detection the integrity check owes.

const KEY = 'test-seal-key-0123456789abcdef0123456789';

let t: Awaited<ReturnType<typeof setupTestApp>>;
let till: Till;
beforeAll(async () => {
  t = await setupTestApp();
  configureFiscal({ FISCAL_SEAL_KEY: KEY });
});
afterAll(() => t.close());
beforeEach(async () => {
  till = await openTill(t);
});
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

/** The till's side: a register counter and a chain of seals, as the offline till keeps them. */
function register() {
  let seq = 0;
  let prev = GENESIS_HASH;
  return {
    async seal<T extends SealedOp>(build: (n: string) => T): Promise<T> {
      seq++;
      const op = build(registerNumber('CAISSE1', seq));
      const seal = await sealOp(op, seq, prev);
      prev = seal.hash;
      return { ...op, payload: { ...op.payload, seal } } as T;
    },
    skip() {
      seq++;
    },
  };
}

async function sealedSale(
  reg: ReturnType<typeof register>,
  lines: Parameters<Till['saleOp']>[0],
  paid: string,
) {
  const base = till.saleOp(lines, paid) as Extract<SealedOp, { kind: 'SALE' }>;
  return reg.seal((no) => ({ ...base, payload: { ...base.payload, provisionalNumber: no } }));
}

const rowOf = async (id: string) =>
  (
    await t.db.execute<Record<string, string | number | null>>(
      sql`select * from app.sale where id = ${id}`,
    )
  ).rows[0]!;

const api = (method: 'GET' | 'POST', url: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: till.admin, payload });

const forceClose = async () =>
  expect(
    (await api('POST', `/pos/sessions/${till.sessionId}/force-close`, { comment: 'test' }))
      .statusCode,
  ).toBe(200);

describe('the till seals its tickets (§1)', () => {
  it('records a sealed ticket with its register number and chain, and chains it in the journal', async () => {
    const p = await addProduct(t.db);
    const reg = register();
    const a = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.50' }], '2.50');
    const b = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.50' }], '2.50');
    const res = await till.push([a, b]);
    expect(res.map((r) => r.status)).toEqual(['OK', 'OK']);
    expect(res[0]!.warnings.filter((w) => !w.code.startsWith('POLICY_'))).toEqual([]);
    const ra = await rowOf(a.id);
    const rb = await rowOf(b.id);
    expect(ra).toMatchObject({
      register_seq: 1,
      till_seal_status: 'OK',
      provisional_number: 'CAISSE1-000001',
    });
    expect(rb).toMatchObject({
      register_seq: 2,
      till_prev_hash: ra.till_hash,
      till_seal_status: 'OK',
    });
    const journal = await t.db.execute<{ kind: string; seq: number }>(
      sql`select seq, kind from app.fiscal_journal order by seq`,
    );
    expect(journal.rows.map((r) => r.kind)).toEqual(['SESSION_OPEN', 'SALE', 'SALE']);
    const v = (await api('GET', '/admin/fiscal/verify')).json();
    expect(v).toMatchObject({ ok: true, signed: true, entries: 3 });
    await expectIntegrity(t.db);
  });

  it('keeps a ticket whose seal does not match, flags it, and the integrity check reports it', async () => {
    const p = await addProduct(t.db);
    const reg = register();
    const good = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.50' }], '2.50');
    // Altered after sealing: the amount of the line no longer matches the seal.
    const forged = {
      ...good,
      payload: {
        ...good.payload,
        lines: [{ ...good.payload.lines[0]!, unitPrice: '2.40' }],
        total: '2.40',
        payments: [{ method: 'CASH' as const, amount: '2.40' }],
      },
    } as SyncOp;
    const [r] = await till.push([forged]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('SEAL_INVALID');
    expect(await rowOf(good.id)).toMatchObject({ till_seal_status: 'INVALID' });
    const report = (await api('GET', '/admin/integrity')).json();
    expect(report.checks.find((c: { id: string }) => c.id === 'FIS-03').count).toBe(1);
  });

  it('flags a missing document of the register (a gap in the counter)', async () => {
    const p = await addProduct(t.db);
    const reg = register();
    const first = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.50' }], '2.50');
    reg.skip(); // a ticket printed and lost
    const third = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.50' }], '2.50');
    const res = await till.push([first, third]);
    expect(res[0]!.warnings.filter((w) => !w.code.startsWith('POLICY_'))).toEqual([]);
    expect(res[1]!.warnings.map((w) => w.code)).toContain('SEAL_GAP');
    expect(await rowOf(third.id)).toMatchObject({ till_seal_status: 'GAP' });
  });

  it('flags a register number used twice', async () => {
    const p = await addProduct(t.db);
    const a = await sealedSale(register(), [{ productId: p.id, unitPrice: '1.00' }], '1.00');
    const b = await sealedSale(register(), [{ productId: p.id, unitPrice: '1.00' }], '1.00');
    const res = await till.push([a, b]);
    expect(res[1]!.warnings.map((w) => w.code)).toContain('SEAL_DUPLICATE');
    expect(await rowOf(b.id)).toMatchObject({ till_seal_status: 'DUPLICATE' });
  });
});

describe('tamper detection (§2)', () => {
  async function twoTickets() {
    const p = await addProduct(t.db);
    const reg = register();
    const a = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.50' }], '2.50');
    const b = await sealedSale(reg, [{ productId: p.id, unitPrice: '4.00' }], '4.00');
    await till.push([a, b]);
    expect((await api('GET', '/admin/fiscal/verify')).json().ok).toBe(true);
    return { a, b };
  }

  it('finds an amount changed in SQL by the owner of the tables', async () => {
    const { a } = await twoTickets();
    // The owner is exempt from the history guard: this is the attack the chain is for.
    await t.db.execute(sql`update app.sale set total = '0.50' where id = ${a.id}`);
    await t.db.execute(sql`update app.sale_line set line_total = '0.50' where sale_id = ${a.id}`);
    const v = (await api('GET', '/admin/fiscal/verify')).json();
    expect(v.ok).toBe(false);
    expect(v.findings.map((f: { id: string }) => f.id)).toContain('FIS-01');
    const report = (await api('GET', '/admin/integrity')).json();
    expect(report.checks.find((c: { id: string }) => c.id === 'FIS-01').count).toBe(1);
    expect(report.errors).toBeGreaterThan(0);
  });

  it('finds a payment changed, a line deleted and a ticket deleted', async () => {
    const { a, b } = await twoTickets();
    await t.db.execute(sql`update app.sale_payment set amount = '9.00' where sale_id = ${a.id}`);
    expect((await api('GET', '/admin/fiscal/verify')).json().ok).toBe(false);
    await t.db.execute(sql`update app.sale_payment set amount = '2.50' where sale_id = ${a.id}`);
    expect((await api('GET', '/admin/fiscal/verify')).json().ok).toBe(true);
    await t.db.execute(sql`delete from app.sale_payment where sale_id = ${b.id}`);
    await t.db.execute(sql`delete from app.sale_line where sale_id = ${b.id}`);
    await t.db.execute(sql`delete from app.sale where id = ${b.id}`);
    const v = (await api('GET', '/admin/fiscal/verify')).json();
    expect(v.ok).toBe(false);
    expect(v.findings.find((f: { id: string }) => f.id === 'FIS-01').rows[0].detail).toMatch(
      /n’existe plus/,
    );
  });

  it('finds a journal entry changed, deleted, or the whole chain recomputed without the key', async () => {
    await twoTickets();
    await t.db.execute(sql`update app.fiscal_journal set data = '{}'::jsonb where seq = 2`);
    let v = (await api('GET', '/admin/fiscal/verify')).json();
    expect(v.findings.map((f: { id: string }) => f.id)).toContain('FIS-02');
    // Undo, then delete the last entry (the counter remembers it).
    await t.db.execute(sql`delete from app.fiscal_journal where seq = 3`);
    v = (await api('GET', '/admin/fiscal/verify')).json();
    expect(v.ok).toBe(false);
  });

  it('refuses the application’s role any rewrite of the journal, the closings and the reprints', async () => {
    await twoTickets();
    expect(await refusedToAppRole(sql`delete from app.fiscal_journal`)).toBe('23000');
    expect(await refusedToAppRole(sql`update app.fiscal_journal set kind = 'X'`)).toBe('23000');
    expect(await refusedToAppRole(sql`update app.sale set register_seq = 99`)).toBe('23000');
    expect(await refusedToAppRole(sql`update app.sale set till_hash = 'x'`)).toBe('23000');
    expect(await refusedToAppRole(sql`update app.sale set accounting_day = '2020-01-01'`)).toBe(
      '23000',
    );
  });
});

describe('period closings (§3)', () => {
  const today = () => new Date().toISOString().slice(0, 10); // the tests run in the shop's day

  async function soldAndClosedDay() {
    const p = await addProduct(t.db);
    const reg = register();
    const a = await sealedSale(reg, [{ productId: p.id, unitPrice: '5.00' }], '5.00');
    const b = await sealedSale(reg, [{ productId: p.id, unitPrice: '3.00' }], '3.00');
    await till.push([a, b]);
    return { a, b, p, reg };
  }

  it('refuses a day while a drawer is open, closes it once, and never twice', async () => {
    await soldAndClosedDay();
    const day = (
      await t.db.execute<{ d: string }>(sql`select accounting_day::text as d from app.sale limit 1`)
    ).rows[0]!.d;
    const early = await api('POST', '/fiscal/closings', { kind: 'DAY', start: day });
    expect(early.statusCode).toBe(409);
    expect(early.json().detail).toMatch(/session de caisse est encore ouverte/);
    await forceClose();
    const z = await api('POST', '/fiscal/closings', { kind: 'DAY', start: day });
    expect(z.statusCode).toBe(200);
    expect(z.json()).toMatchObject({
      tickets: 2,
      cancellations: 0,
      returns: 0,
      netTotal: '8.00',
      grandTotal: '8.00',
    });
    expect(z.json().totals.byMethod).toEqual({ CASH: '8.00' });
    expect(z.json().totals.byVat).toHaveLength(1);
    const again = await api('POST', '/fiscal/closings', { kind: 'DAY', start: day });
    expect(again.statusCode).toBe(409);
    expect(again.json().detail).toMatch(/déjà clôturée/);
    const journal = await t.db.execute<{ kind: string }>(
      sql`select kind from app.fiscal_journal order by seq desc limit 1`,
    );
    expect(journal.rows[0]!.kind).toBe('CLOSING_DAY');
    await expectIntegrity(t.db);
  });

  it('lists what is left to close and what can be closed now, with what to do first', async () => {
    await soldAndClosedDay();
    // The drawer is still open: the day is listed, not ready, and says why.
    const early = (await api('GET', '/fiscal/closings/pending')).json();
    expect(early.openSessions).toBe(1);
    expect(early.items).toHaveLength(1);
    expect(early.items[0]).toMatchObject({ kind: 'DAY', tickets: 2, ready: false });
    expect(early.items[0].reason).toMatch(/session de caisse/);

    await forceClose();
    const ready = (await api('GET', '/fiscal/closings/pending')).json();
    expect(ready.items[0]).toMatchObject({ kind: 'DAY', ready: true, reason: null });

    // Closed from the list, the day leaves it (the month is not over yet).
    const z = await api('POST', '/fiscal/closings', { kind: 'DAY', start: ready.items[0].start });
    expect(z.statusCode).toBe(200);
    expect((await api('GET', '/fiscal/closings/pending')).json().items).toEqual([]);

    // The closings are for the administrators and the accountants.
    const asCashier = await t.app.inject({
      url: '/api/v1/fiscal/closings/pending',
      headers: till.cashier,
    });
    expect(asCashier.statusCode).toBe(403);
  });

  it('puts a late ticket on the first open day and never into the closed one', async () => {
    const { p, reg } = await soldAndClosedDay();
    await forceClose();
    const day = today();
    expect((await api('POST', '/fiscal/closings', { kind: 'DAY', start: day })).statusCode).toBe(
      200,
    );
    const late = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.00' }], '2.00');
    const [r] = await till.push([late]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('LATE_AFTER_CLOSING');
    const row = await rowOf(late.id);
    expect(row.accounting_day).not.toBe(day);
    // The database itself refuses to add a ticket to the closed day.
    expect(
      await refusedToAppRole(
        sql`insert into app.sale (id, number, session_id, sold_at, total, accounting_day)
            values (${randomUUID()}, 'T-X', ${till.sessionId}, now(), 1, ${day}::date)`,
      ),
    ).toBe('23000');
    await expectIntegrity(t.db);
  });

  it('keeps the perpetual grand total growing, cancellations and returns included', async () => {
    const { a, reg } = await soldAndClosedDay();
    // A cancellation on the same day: the day nets lower, the grand total adds its absolute value.
    const cancel = await reg.seal((no) => ({
      kind: 'SALE_CANCEL',
      id: randomUUID(),
      deviceSeq: till.nextSeq(),
      payload: {
        cancelSaleId: randomUUID(),
        saleId: a.id,
        sessionId: till.sessionId,
        cashierId: till.cashierId,
        at: new Date().toISOString(),
        provisionalNumber: no,
      },
    }));
    expect((await till.push([cancel]))[0]!.status).toBe('OK');
    await forceClose();
    const day = today();
    const z = (await api('POST', '/fiscal/closings', { kind: 'DAY', start: day })).json();
    expect(z).toMatchObject({
      tickets: 2,
      cancellations: 1,
      netTotal: '3.00',
      grandTotal: '13.00',
    });
  });

  it('refuses a month before it is over, or with a day left open', async () => {
    await soldAndClosedDay();
    const month = `${today().slice(0, 7)}-01`;
    const res = await api('POST', '/fiscal/closings', { kind: 'MONTH', start: month });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/pas terminée/);
    expect(
      (await api('POST', '/fiscal/closings', { kind: 'MONTH', start: '2026-11-15' })).statusCode,
    ).toBe(409);
  });

  it('closes by itself the days gone by, in order, once their drawers are closed', async () => {
    await soldAndClosedDay();
    await forceClose();
    // Seen from two days later, today's day is gone by.
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect(await autoCloseDays(t.jobsDb, later)).toBe(1);
    expect(await autoCloseDays(t.jobsDb, later)).toBe(0);
    const z = (await api('GET', '/fiscal/closings')).json();
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ kind: 'DAY', closedBy: null });
  });

  it('does not reopen the session of a closed day', async () => {
    await soldAndClosedDay();
    await forceClose();
    expect(
      (await api('POST', '/fiscal/closings', { kind: 'DAY', start: today() })).statusCode,
    ).toBe(200);
    const res = await api('POST', `/pos/sessions/${till.sessionId}/reopen`);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/clôturée \(Z\)/);
  });
});

describe('credit notes (§5)', () => {
  async function ticket(unitPrice = '10.00', qty = '3') {
    const p = await addProduct(t.db, { stockQty: '20' });
    const reg = register();
    const sale = await sealedSale(
      reg,
      [{ productId: p.id, qty, unitPrice }],
      (Number(unitPrice) * Number(qty)).toFixed(2),
    );
    await till.push([sale]);
    return { p, reg, sale };
  }
  const returnOp = (
    reg: ReturnType<typeof register>,
    saleId: string,
    over: Record<string, unknown> = {},
  ) =>
    reg.seal((no) => ({
      kind: 'SALE_RETURN',
      id: randomUUID(),
      deviceSeq: till.nextSeq(),
      payload: {
        returnSaleId: randomUUID(),
        saleId,
        sessionId: till.sessionId,
        cashierId: till.cashierId,
        at: new Date().toISOString(),
        provisionalNumber: no,
        reason: 'Produit abîmé',
        refundMethod: 'CASH',
        restock: true,
        lines: [{ lineNo: 1, qty: '1' }],
        ...over,
      },
    })) as Promise<Extract<SealedOp, { kind: 'SALE_RETURN' }>>;
  const stock = async (id: string) =>
    Number(
      (
        await t.db.execute<{ s: string }>(
          sql`select stock_qty::text as s from app.product where id = ${id}`,
        )
      ).rows[0]!.s,
    );

  it('gives back some of the lines as a negative document linked to the ticket', async () => {
    const { p, reg, sale } = await ticket();
    expect(await stock(p.id)).toBe(17);
    const op = await returnOp(reg, sale.id);
    const [r] = await till.push([op]);
    expect(r).toMatchObject({ status: 'OK' });
    const row = await rowOf(op.payload.returnSaleId);
    expect(row).toMatchObject({
      total: '-10.00',
      returns_sale_id: sale.id,
      return_reason: 'Produit abîmé',
      refund_method: 'CASH',
      till_seal_status: 'OK',
    });
    expect(await stock(p.id)).toBe(18);
    const pay = await t.db.execute(
      sql`select amount::text from app.sale_payment where sale_id = ${op.payload.returnSaleId}`,
    );
    expect(pay.rows[0]).toMatchObject({ amount: '-10.00' });
    const audit = await t.db.execute(
      sql`select count(*)::int as n from app.audit_log where action = 'sale.return'`,
    );
    expect(audit.rows[0]).toMatchObject({ n: 1 });
    await expectIntegrity(t.db);
  });

  it('writes the goods off when they are not put back in stock', async () => {
    const { p, reg, sale } = await ticket();
    const op = await returnOp(reg, sale.id, { restock: false });
    expect((await till.push([op]))[0]!.status).toBe('OK');
    expect(await stock(p.id)).toBe(17);
    const loss = await t.db.execute(
      sql`select count(*)::int as n from app.stock_movement where kind = 'LOSS' and source_id = ${op.payload.returnSaleId}`,
    );
    expect(loss.rows[0]).toMatchObject({ n: 1 });
    await expectIntegrity(t.db);
  });

  it('never refunds more than was sold, line by line, over several credit notes', async () => {
    const { reg, sale } = await ticket('10.00', '3');
    const first = await returnOp(reg, sale.id, { lines: [{ lineNo: 1, qty: '2' }] });
    const second = await returnOp(reg, sale.id, { lines: [{ lineNo: 1, qty: '2' }] });
    const [r1, r2] = await till.push([first, second]);
    expect(r1!.status).toBe('OK');
    expect(r2!.status).toBe('REJECTED');
    expect(r2!.error).toMatch(/il reste 1/);
    const third = await returnOp(reg, sale.id, { lines: [{ lineNo: 1, qty: '1' }] });
    expect((await till.push([third]))[0]!.status).toBe('OK');
    const sum = await t.db.execute<{ s: string }>(
      sql`select sum(total)::text as s from app.sale where returns_sale_id = ${sale.id}`,
    );
    expect(sum.rows[0]!.s).toBe('-30.00');
    // Nothing left on that line.
    const fourth = await returnOp(reg, sale.id, { lines: [{ lineNo: 1, qty: '0.001' }] });
    expect((await till.push([fourth]))[0]!.status).toBe('REJECTED');
  });

  it('refuses a refund by a method that was not used for the sale, and a line that does not exist', async () => {
    const { reg, sale } = await ticket();
    const card = await returnOp(reg, sale.id, { refundMethod: 'CARD' });
    expect((await till.push([card]))[0]!.error).toMatch(/dépasse ce qui a été payé/);
    const wallet = await returnOp(reg, sale.id, { refundMethod: 'WALLET' });
    expect((await till.push([wallet]))[0]!.error).toMatch(/adhérent/);
    const ghost = await returnOp(reg, sale.id, { lines: [{ lineNo: 7, qty: '1' }] });
    expect((await till.push([ghost]))[0]!.error).toMatch(/n’existe pas/);
  });

  it('does not cancel a ticket already refunded in part, nor refund a cancelled one', async () => {
    const { reg, sale } = await ticket();
    expect((await till.push([await returnOp(reg, sale.id)]))[0]!.status).toBe('OK');
    const cancelOp = (saleId: string) =>
      reg.seal((no) => ({
        kind: 'SALE_CANCEL',
        id: randomUUID(),
        deviceSeq: till.nextSeq(),
        payload: {
          cancelSaleId: randomUUID(),
          saleId,
          sessionId: till.sessionId,
          cashierId: till.cashierId,
          at: new Date().toISOString(),
          provisionalNumber: no,
        },
      }));
    const refused = (await till.push([await cancelOp(sale.id)]))[0]!;
    expect(refused.status).toBe('REJECTED');
    expect(refused.error).toMatch(/remboursé en partie/);

    const other = await ticket();
    expect((await till.push([await cancelOp(other.sale.id)]))[0]!.status).toBe('OK');
    const after = await returnOp(other.reg, other.sale.id);
    const res = (await till.push([after]))[0]!;
    expect(res.status).toBe('REJECTED');
    expect(res.error).toMatch(/annulé/);
  });
});

describe('duplicata (§4)', () => {
  it('counts and logs every reprint, in the audit log and in the chained journal', async () => {
    const p = await addProduct(t.db);
    const reg = register();
    const sale = await sealedSale(reg, [{ productId: p.id, unitPrice: '2.00' }], '2.00');
    await till.push([sale]);
    const reprint = (): SyncOp => ({
      kind: 'TICKET_REPRINT',
      id: randomUUID(),
      deviceSeq: till.nextSeq(),
      payload: {
        saleId: sale.id,
        sessionId: till.sessionId,
        cashierId: till.cashierId,
        at: new Date().toISOString(),
      },
    });
    const res = await till.push([reprint(), reprint()]);
    expect(res.map((r) => r.status)).toEqual(['OK', 'OK']);
    const copies = await t.db.execute(sql`select copy_no from app.ticket_reprint order by copy_no`);
    expect(copies.rows.map((r) => r.copy_no)).toEqual([1, 2]);
    const logged = await t.db.execute(
      sql`select count(*)::int as n from app.audit_log where action = 'sale.reprint'`,
    );
    expect(logged.rows[0]).toMatchObject({ n: 2 });
    const chained = await t.db.execute(
      sql`select count(*)::int as n from app.fiscal_journal where kind = 'DUPLICATA'`,
    );
    expect(chained.rows[0]).toMatchObject({ n: 2 });
    expect(await refusedToAppRole(sql`delete from app.ticket_reprint`)).toBe('23000');
    await expectIntegrity(t.db);
  });
});

describe('cash ceiling (§6)', () => {
  it('records a cash payment above 1 000 € with a warning', async () => {
    const p = await addProduct(t.db, { salePrice: '1200.00' });
    const op = till.saleOp([{ productId: p.id, unitPrice: '1200.00' }], '1200.00');
    const [r] = await till.push([op]);
    expect(r!.status).toBe('OK');
    expect(r!.warnings.map((w) => w.code)).toContain('CASH_LIMIT_EXCEEDED');
    const report = (await api('GET', '/admin/integrity')).json();
    expect(report.checks.find((c: { id: string }) => c.id === 'FIS-05').count).toBe(1);
  });
});

describe('the archive (§8)', () => {
  it('is signed, verifies, and fails once an amount is changed', async () => {
    const p = await addProduct(t.db);
    const reg = register();
    await till.push([
      await sealedSale(reg, [{ productId: p.id, unitPrice: '2.50' }], '2.50'),
      await sealedSale(reg, [{ productId: p.id, unitPrice: '1.50' }], '1.50'),
    ]);
    const day = (
      await t.db.execute<{ d: string }>(sql`select accounting_day::text as d from app.sale limit 1`)
    ).rows[0]!.d;
    const res = await api('GET', `/admin/fiscal/archive?from=${day}&to=${day}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/archive-fiscale/);
    const archive = res.json() as FiscalArchive;
    expect(archive.manifest.counts).toMatchObject({ sales: 2, saleLines: 2, salePayments: 2 });
    expect(archive.signature).not.toBeNull();
    expect((await verifyArchive(archive, KEY)).ok).toBe(true);
    const viaApi = await api('POST', '/admin/fiscal/archive/verify', archive as unknown as object);
    expect(viaApi.json()).toMatchObject({ ok: true, signatureChecked: true });

    (archive.sections.sales[0] as { total: string }).total = '0.01';
    const bad = await api('POST', '/admin/fiscal/archive/verify', archive as unknown as object);
    expect(bad.json().ok).toBe(false);
    const audited = await t.db.execute(
      sql`select count(*)::int as n from app.audit_log where action = 'fiscal.archive'`,
    );
    expect(audited.rows[0]).toMatchObject({ n: 1 });
  });
});
