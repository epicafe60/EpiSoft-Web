import Dexie, { type EntityTable } from 'dexie';
import type {
  SnapshotHousehold,
  SnapshotMember,
  SnapshotMembershipType,
  SnapshotPosTab,
  SnapshotProduct,
  SyncOp,
  SyncResult,
  TillSettings,
} from '@episoft/shared';

// The till's local database (R-OFF-02, R-OFF-03, R-OFF-06). It survives page reloads,
// browser restarts and reboots; nothing here is lost when the network is down.

export type OutboxStatus = 'PENDING' | 'DONE' | 'REJECTED';

export interface OutboxEntry {
  /** The operation id (also the sale id for a SALE). */
  id: string;
  seq: number;
  kind: SyncOp['kind'];
  op: SyncOp;
  status: OutboxStatus;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  /** When the server answered; until the next snapshot, its effects are still estimated locally. */
  syncedAt: string | null;
  result: SyncResult | null;
}

export interface DraftLine {
  productId: string;
  label: string;
  qtyMilli: number;
  unitPriceCents: number;
  catalogPriceCents: number;
  discountCents: number;
}

/** A ticket being entered or put on hold (R-VTE-08). */
export interface Draft {
  id: string;
  memberId: string | null;
  /** R-PRE-03: pre-order being collected with this ticket. */
  preorderId?: string | null;
  lines: DraftLine[];
  parked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

export class TillDb extends Dexie {
  products!: EntityTable<SnapshotProduct, 'id'>;
  members!: EntityTable<SnapshotMember, 'id'>;
  households!: EntityTable<SnapshotHousehold, 'id'>;
  membershipTypes!: EntityTable<SnapshotMembershipType, 'id'>;
  posTabs!: EntityTable<SnapshotPosTab, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'id'>;
  drafts!: EntityTable<Draft, 'id'>;
  meta!: EntityTable<MetaEntry, 'key'>;

  constructor(name = 'episoft-till') {
    super(name);
    this.version(1).stores({
      products: 'id, code, *eans, posTabId, status',
      members: 'id, number, qrTokenHash, householdId',
      households: 'id',
      membershipTypes: 'id',
      posTabs: 'id',
      outbox: 'id, &seq, status',
      drafts: 'id, parked, updatedAt',
      meta: 'key',
    });
  }
}

export const tillDb = new TillDb();

// --- Meta helpers ----------------------------------------------------------------------

export interface MetaValues {
  device: { id: string; name: string } | null;
  /** Open session on this device (possibly not yet known by the server). */
  session: { id: string; openedAt: string; openingFloat: string } | null;
  deviceSeq: number;
  cursor: string | null;
  lastSnapshotAt: string | null;
  lastPushAt: string | null;
  settings: TillSettings | null;
  cashierId: string | null;
  activeDraftId: string | null;
}

const DEFAULTS: MetaValues = {
  device: null,
  session: null,
  deviceSeq: 0,
  cursor: null,
  lastSnapshotAt: null,
  lastPushAt: null,
  settings: null,
  cashierId: null,
  activeDraftId: null,
};

export async function getMeta<K extends keyof MetaValues>(
  key: K,
  db = tillDb,
): Promise<MetaValues[K]> {
  const row = await db.meta.get(key);
  return (row ? row.value : DEFAULTS[key]) as MetaValues[K];
}

export async function setMeta<K extends keyof MetaValues>(
  key: K,
  value: MetaValues[K],
  db = tillDb,
): Promise<void> {
  await db.meta.put({ key, value });
}
