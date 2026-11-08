import { shouldDropSession, type Snapshot, type SyncOp, type SyncResult } from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { getMeta, setMeta, tillDb, type OutboxEntry, type TillDb } from './db';
import { backoffMs, newDeviceName } from './logic';

// Sync engine (spec §8.3, R-OFF-02, R-OFF-03). One instance per page; it only talks to the
// server when online and keeps every operation in IndexedDB until the server has answered.

export type SyncState = {
  online: boolean;
  pushing: boolean;
  /** The server refused our session cookie: the user must log in again (sales are kept). */
  authRequired: boolean;
  /** The server does not accept this device: its sales wait in the queue (R-OFF-03). */
  deviceProblem: 'DEVICE_UNKNOWN' | 'DEVICE_DISABLED' | null;
  lastError: string | null;
};

type Listener = (s: SyncState) => void;

const SNAPSHOT_EVERY_MS = 5 * 60_000;
const PUSH_BATCH = 50;

/**
 * Adds an operation to the outbox with the next device sequence number, in one IndexedDB
 * transaction (R-OFF-06: written before the till shows the operation as done).
 */
export async function enqueue(
  build: (deviceSeq: number) => SyncOp,
  extra?: () => Promise<void>,
  db: TillDb = tillDb,
): Promise<SyncOp> {
  return db.transaction('rw', [db.outbox, db.meta, db.drafts], async () => {
    const seq = (await getMeta('deviceSeq', db)) + 1;
    const op = build(seq);
    await db.outbox.add({
      id: op.id,
      seq,
      kind: op.kind,
      op,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      syncedAt: null,
      result: null,
    });
    await setMeta('deviceSeq', seq, db);
    if (extra) await extra();
    return op;
  });
}

export class SyncEngine {
  private state: SyncState = {
    online: navigator.onLine,
    pushing: false,
    authRequired: false,
    deviceProblem: null,
    lastError: null,
  };
  private listeners = new Set<Listener>();
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private db: TillDb = tillDb) {}

  start() {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.snapshotTimer = setInterval(() => void this.refresh(), SNAPSHOT_EVERY_MS);
    void this.refresh().then(() => this.kick());
  }

  stop() {
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    clearInterval(this.snapshotTimer);
    clearTimeout(this.timer);
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    l(this.state);
    return () => {
      this.listeners.delete(l);
    };
  }

  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private onOnline = () => {
    this.set({ online: true });
    this.failures = 0;
    this.kick();
    void this.refresh();
  };

  private onOffline = () => this.set({ online: false });

  /** Push now (after a sale), then keep retrying with back-off while operations wait. */
  kick() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pushLoop(), 0);
  }

  private async pushLoop() {
    if (this.running) return;
    this.running = true;
    try {
      const ok = await this.pushOnce();
      const remaining = await this.db.outbox.where('status').equals('PENDING').count();
      if (remaining > 0) {
        this.failures = ok ? 0 : this.failures + 1;
        this.timer = setTimeout(() => void this.pushLoop(), ok ? 0 : backoffMs(this.failures));
      }
    } finally {
      this.running = false;
    }
  }

  /** Sends one batch in sequence order. Returns false when the server could not be reached. */
  async pushOnce(): Promise<boolean> {
    const device = await getMeta('device', this.db);
    if (!device) return true;
    const batch: OutboxEntry[] = await this.db.outbox
      .where('status')
      .equals('PENDING')
      .sortBy('seq');
    if (!batch.length) return true;
    const ops = batch.slice(0, PUSH_BATCH);
    this.set({ pushing: true });
    try {
      const { results, serverTime } = await api.post<{
        results: SyncResult[];
        serverTime?: string;
      }>('/sync/push', {
        deviceId: device.id,
        ops: ops.map((e) => e.op),
      });
      // C06: dated by the server (an older server does not say: the till's clock then).
      const now = serverTime ?? new Date().toISOString();
      await this.db.transaction('rw', this.db.outbox, async () => {
        for (const r of results) {
          await this.db.outbox.update(r.id, {
            status: r.status === 'OK' ? 'DONE' : 'REJECTED',
            result: r,
            syncedAt: now,
            lastError: r.error ?? null,
          });
        }
      });
      await this.adoptJoinedSession(results);
      // The health banners compare it with the till's own clock: kept in local time.
      await setMeta('lastPushAt', new Date().toISOString(), this.db);
      this.set({ online: true, authRequired: false, deviceProblem: null, lastError: null });
      // New balances and stock: refresh the replicated data at once.
      void this.refresh();
      return true;
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      for (const o of ops)
        await this.db.outbox.update(o.id, {
          attempts: o.attempts + 1,
          lastError: err?.message ?? String(e),
        });
      if (err?.status === 401) this.set({ authRequired: true });
      const code = err?.problem.code;
      this.set({
        online: err ? err.status !== 0 : false,
        deviceProblem: code === 'DEVICE_UNKNOWN' || code === 'DEVICE_DISABLED' ? code : null,
        lastError: err?.message ?? String(e),
      });
      if (code === 'DEVICE_UNKNOWN') void this.redeclareAuto();
      return false;
    } finally {
      this.set({ pushing: false });
    }
  }

  private redeclaring = false;

  /**
   * Nobody should have to know about « postes »: a device the server forgot is declared again on
   * its own, under its old name if that is free, else under a generated one. Only when this fails
   * (no network, a refusal) does the till show its banner.
   */
  private async redeclareAuto(): Promise<void> {
    if (this.redeclaring) return;
    this.redeclaring = true;
    try {
      const old = (await getMeta('device', this.db))?.name;
      for (const name of [old, newDeviceName(), newDeviceName(), newDeviceName()]) {
        if (!name) continue;
        try {
          await this.redeclare(name);
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) return; // not a taken name: give up
        }
      }
    } finally {
      this.redeclaring = false;
    }
  }

  /**
   * R-SES-05: the session this till opened (offline, say) was attached to the one already open:
   * from now on the till works in that one. Its tickets already made under the first id are
   * found there by the server (alias).
   */
  private async adoptJoinedSession(results: SyncResult[]): Promise<void> {
    const session = await getMeta('session', this.db);
    const joined = results.find((r) => r.id === session?.id && r.sessionId && r.sessionId !== r.id);
    if (session && joined?.sessionId)
      await setMeta('session', { ...session, id: joined.sessionId }, this.db);
  }

  /**
   * The server no longer knows this device (deleted, database restored): it declares a new one
   * under `name`. The queue, the sequence numbers and the open session are kept: the waiting
   * operations are sent under the new device as soon as it exists.
   */
  async redeclare(name: string): Promise<void> {
    const d = await api.post<{ id: string; name: string }>('/pos/devices', { name: name.trim() });
    await setMeta('device', d, this.db);
    this.failures = 0;
    this.set({ deviceProblem: null, lastError: null });
    this.kick();
  }

  /**
   * R-EVO-06: the session was closed from another till. It is forgotten here (the tickets still
   * in the queue are sent and recorded with a warning), unless it is our own, not yet sent.
   */
  private async dropClosedSession(open: { id: string }[] | undefined): Promise<void> {
    const session = await getMeta('session', this.db);
    const pending = (
      await this.db.outbox
        .filter((o) => o.status === 'PENDING' && o.op.kind === 'SESSION_OPEN')
        .toArray()
    ).map((o) => o.id);
    if (
      shouldDropSession(
        session?.id ?? null,
        open?.map((s) => s.id),
        pending,
      )
    )
      await setMeta('session', null, this.db);
  }

  /** R-OFF-02: incremental refresh of the replicated data (full the first time). */
  async refresh(): Promise<boolean> {
    const cursor = await getMeta('cursor', this.db);
    try {
      const snap = await api.get<Snapshot>(
        `/sync/snapshot${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`,
      );
      await this.db.transaction(
        'rw',
        [
          this.db.products,
          this.db.members,
          this.db.households,
          this.db.membershipTypes,
          this.db.posTabs,
          this.db.meta,
        ],
        async () => {
          if (snap.full) {
            await this.db.products.clear();
            await this.db.members.clear();
            await this.db.posTabs.clear();
          }
          await this.db.products.bulkPut(snap.products);
          await this.db.members.bulkPut(snap.members);
          await this.db.households.clear();
          await this.db.households.bulkPut(snap.households);
          await this.db.membershipTypes.clear();
          await this.db.membershipTypes.bulkPut(snap.membershipTypes);
          await this.db.posTabs.bulkPut(snap.posTabs);
          await setMeta('settings', snap.settings, this.db);
          await setMeta('cursor', snap.cursor, this.db);
          await setMeta('lastSnapshotAt', snap.serverTime, this.db);
        },
      );
      await this.dropClosedSession(snap.settings.openSessions);
      this.set({ online: true, authRequired: false });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.set({ authRequired: true });
      if (e instanceof ApiError && e.status === 0) this.set({ online: false });
      return false;
    }
  }
}
