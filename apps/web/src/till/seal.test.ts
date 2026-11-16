import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, tillSealIsConsistent, type SealedOp } from '@episoft/shared';
import { getMeta, setMeta, TillDb } from './db';
import { enqueueSealed } from './sync';

// ADR 0016 §1: the register's counter and the seal of each document, offline.

const sale = (id: string, deviceSeq: number, no: string): SealedOp => ({
  kind: 'SALE',
  id,
  deviceSeq,
  payload: {
    sessionId: '22222222-2222-4222-8222-222222222222',
    cashierId: '33333333-3333-4333-8333-333333333333',
    memberId: null,
    soldAt: '2026-11-15T10:00:00.000Z',
    provisionalNumber: no,
    lines: [
      {
        productId: '44444444-4444-4444-8444-444444444444',
        label: 'Lentilles',
        qty: '1',
        unitPrice: '2.50',
        catalogPrice: '2.50',
        discount: '0.00',
      },
    ],
    payments: [{ method: 'CASH', amount: '2.50' }],
    total: '2.50',
    emailReceipt: false,
  },
});

const newDb = () => new TillDb(`seal-${Math.random()}`);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('enqueueSealed', () => {
  it('numbers the documents without a gap, whatever else the till queued in between', async () => {
    const db = newDb();
    // Other operations (a session opening, a top-up) use device sequence numbers too.
    await setMeta('deviceSeq', 7, db);
    const numbers: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const op = await enqueueSealed(
        'CAISSE1',
        ({ deviceSeq, number }) => sale(id(n), deviceSeq, number),
        undefined,
        db,
      );
      numbers.push(op.payload.provisionalNumber);
    }
    expect(numbers).toEqual(['CAISSE1-000001', 'CAISSE1-000002', 'CAISSE1-000003']);
    expect((await db.outbox.orderBy('seq').toArray()).map((e) => e.seq)).toEqual([8, 9, 10]);
    expect((await getMeta('ticketSeal', db)).seq).toBe(3);
  });

  it('seals each document on top of the previous one, and the seal holds', async () => {
    const db = newDb();
    const a = await enqueueSealed('CAISSE1', (x) => sale(id(1), x.deviceSeq, x.number), undefined, db);
    const b = await enqueueSealed('CAISSE1', (x) => sale(id(2), x.deviceSeq, x.number), undefined, db);
    expect(a.payload.seal).toMatchObject({ seq: 1, prev: GENESIS_HASH });
    expect(b.payload.seal).toMatchObject({ seq: 2, prev: a.payload.seal!.hash });
    expect(await tillSealIsConsistent(a, a.payload.seal!)).toBe(true);
    expect((await getMeta('ticketSeal', db)).hash).toBe(b.payload.seal!.hash);
    // What is stored in the outbox is what was sealed.
    const stored = (await db.outbox.get(b.id))!.op as SealedOp;
    expect(await tillSealIsConsistent(stored, stored.payload.seal!)).toBe(true);
  });

  it('gives no number when the ticket cannot be stored (same transaction)', async () => {
    const db = newDb();
    await enqueueSealed('CAISSE1', (x) => sale(id(1), x.deviceSeq, x.number), undefined, db);
    await expect(
      enqueueSealed(
        'CAISSE1',
        (x) => sale(id(2), x.deviceSeq, x.number),
        () => Promise.reject(new Error('disque plein')),
        db,
      ),
    ).rejects.toThrow('disque plein');
    // The number of the failed ticket is given to the next one: no gap.
    const next = await enqueueSealed('CAISSE1', (x) => sale(id(3), x.deviceSeq, x.number), undefined, db);
    expect(next.payload.provisionalNumber).toBe('CAISSE1-000002');
    expect(await db.outbox.count()).toBe(2);
  });

  it('two documents sealed at once get two numbers and a single chain', async () => {
    const db = newDb();
    const [a, b] = await Promise.all([
      enqueueSealed('CAISSE1', (x) => sale(id(1), x.deviceSeq, x.number), undefined, db),
      enqueueSealed('CAISSE1', (x) => sale(id(2), x.deviceSeq, x.number), undefined, db),
    ]);
    const seals = [a, b].map((o) => o.payload.seal!).sort((x, y) => x.seq - y.seq);
    expect(seals.map((s) => s.seq)).toEqual([1, 2]);
    expect(seals[1]!.prev).toBe(seals[0]!.hash);
  });
});
