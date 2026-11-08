import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SyncOp } from '@episoft/shared';
import { forgetPersonalData, getMeta, setMeta, TillDb, type OutboxEntry } from './db';

const entry = (id: string, seq: number, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id,
  seq,
  kind: 'SALE',
  op: { kind: 'SALE' } as unknown as SyncOp,
  status: 'PENDING',
  createdAt: '2026-11-07T10:00:00Z',
  attempts: 0,
  lastError: null,
  syncedAt: null,
  result: null,
  ...over,
});

describe('audit KV2, S05: sign-out on a shared device', () => {
  it('forgets the members and what the server has, keeps what it does not have yet', async () => {
    const db = new TillDb(`forget-${Math.random()}`);
    await db.members.put({
      id: 'm1',
      number: 12,
      firstName: 'Marie',
      lastName: 'Dupont',
      householdId: 'h1',
      status: 'ACTIVE',
      qrTokenHash: 'abc',
      isCashier: false,
      hasEmail: true,
    });
    await db.households.put({ id: 'h1', number: 7, balance: '42.00' } as never);
    await db.drafts.put({
      id: 'd1',
      memberId: 'm1',
      lines: [],
      parked: true,
      createdAt: '2026-11-07T10:00:00Z',
      updatedAt: '2026-11-07T10:00:00Z',
    });
    await db.outbox.bulkPut([
      entry('pending', 1),
      entry('done', 2, { status: 'DONE', syncedAt: '2026-11-07T10:01:00Z' }),
      entry('refused', 3, { status: 'REJECTED' }),
      entry('handled', 4, { status: 'REJECTED', acknowledged: true }),
    ]);
    await setMeta('device', { id: 'dev', name: 'Caisse 1' }, db);
    await setMeta('deviceSeq', 4, db);
    await setMeta('cursor', '2026-11-07T10:00:00Z', db);
    await setMeta('activeDraftId', 'd1', db);
    // R-SES-07: another cashier keeps the till.
    await setMeta(
      'cashier',
      { id: 'm2', check: 'PIN', lastActivityAt: '2026-11-07T10:00:00Z' },
      db,
    );

    await forgetPersonalData(db);

    expect(await db.members.count()).toBe(0);
    expect(await db.households.count()).toBe(0);
    expect(await db.drafts.count()).toBe(0);
    expect((await db.outbox.toArray()).map((e) => e.id).sort()).toEqual(['pending', 'refused']);
    // The next snapshot is a full one; the device and its sequence are kept.
    expect(await getMeta('cursor', db)).toBeNull();
    expect(await getMeta('activeDraftId', db)).toBeNull();
    // The next person signed in keeps the till, not the last cashier of the previous one.
    expect(await getMeta('cashier', db)).toBeNull();
    expect(await getMeta('device', db)).toEqual({ id: 'dev', name: 'Caisse 1' });
    expect(await getMeta('deviceSeq', db)).toBe(4);
    db.close();
  });
});
