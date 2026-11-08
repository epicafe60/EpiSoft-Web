import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncOp } from '@episoft/shared';
import { setMeta, TillDb } from './db';

// Audit KV2, C06: an operation sent is dated with the server's time, never with the till's clock
// (a till ahead of time used to count again a purchase the snapshot already included).

const post = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  // The refresh after a push waits forever: only the push is looked at here.
  api: { post: (...a: unknown[]) => post(...a), get: () => new Promise(() => {}) },
}));

const { SyncEngine } = await import('./sync');

afterEach(() => {
  vi.useRealTimers();
  post.mockReset();
});

describe('SyncEngine.pushOnce', () => {
  it('dates the operations it sent with the server time given in the answer', async () => {
    const db = new TillDb(`sync-${Math.random()}`);
    await setMeta('device', { id: 'dev-1', name: 'CAISSE1' } as never, db);
    await db.outbox.put({
      id: 'op-1',
      seq: 1,
      kind: 'SALE',
      op: { kind: 'SALE', id: 'op-1' } as unknown as SyncOp,
      status: 'PENDING',
      createdAt: '2026-11-08T12:00:00Z',
      attempts: 0,
      lastError: null,
      syncedAt: null,
      result: null,
    });
    // The till's clock is five minutes ahead of the server.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T12:05:00Z'));
    post.mockResolvedValueOnce({
      results: [{ id: 'op-1', status: 'OK', warnings: [] }],
      serverTime: '2026-11-08T12:00:01.000Z',
    });

    expect(await new SyncEngine(db).pushOnce()).toBe(true);
    const sent = await db.outbox.get('op-1');
    expect(sent).toMatchObject({ status: 'DONE', syncedAt: '2026-11-08T12:00:01.000Z' });
  });
});
