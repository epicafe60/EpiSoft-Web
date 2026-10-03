import { describe, expect, it } from 'vitest';
import type { SnapshotProduct, SyncOp } from '@episoft/shared';
import type { OutboxEntry } from './db';
import { addProduct, backoffMs, draftTotalCents, pendingWalletMoves, saleOp } from './logic';

const product = (over: Partial<SnapshotProduct> = {}): SnapshotProduct => ({
  id: 'p1',
  code: '111001',
  name: 'Chips',
  kind: 'GOODS',
  saleMode: 'UNIT',
  unit: null,
  unitQty: null,
  status: 'ACTIVE',
  salePrice: '2.50',
  vatRate: '5.50',
  eans: [],
  posTabId: null,
  posSort: 0,
  posLabel: null,
  imageId: null,
  membershipTypeId: null,
  ...over,
});

describe('ticket lines (R-VTE-04, R-VTE-05)', () => {
  it('a product scanned twice increases the quantity of its line', () => {
    let lines = addProduct([], product(), 1000);
    lines = addProduct(lines, product(), 1000);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.qtyMilli).toBe(2000);
    expect(draftTotalCents({ lines })).toBe(500);
  });

  it('a line with a changed price stays separate', () => {
    let lines = addProduct([], product(), 1000);
    lines = [{ ...lines[0]!, unitPriceCents: 200 }];
    lines = addProduct(lines, product(), 1000);
    expect(lines).toHaveLength(2);
  });

  it('weighted products carry their quantity', () => {
    const lines = addProduct([], product({ saleMode: 'WEIGHT', salePrice: '12.90' }), 333);
    expect(draftTotalCents({ lines })).toBe(430);
  });
});

function entry(op: SyncOp, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: op.id,
    seq: op.deviceSeq,
    kind: op.kind,
    op,
    status: 'PENDING',
    createdAt: '',
    attempts: 0,
    lastError: null,
    syncedAt: null,
    result: null,
    ...over,
  };
}

const sale = (id: string, memberId: string, payments: Parameters<typeof saleOp>[0]['payments']) =>
  saleOp({
    id,
    deviceSeq: 1,
    draft: {
      id,
      memberId,
      lines: addProduct([], product({ salePrice: '10.00' }), 1000),
      parked: false,
      createdAt: '',
      updatedAt: '',
    },
    sessionId: 's',
    cashierId: 'c',
    provisionalNumber: 'X-1',
    payments,
    emailReceipt: false,
    overdraftForcedBy: null,
    now: new Date('2026-10-03T10:00:00Z'),
  });

describe('estimated cagnotte balance (R-OFF-04)', () => {
  const household = (m: string) => (m === 'm1' || m === 'm2' ? 'h1' : null);

  it('counts pending wallet payments and change paid into the cagnotte', () => {
    const outbox = [
      entry(sale('a', 'm1', [{ method: 'WALLET', amountCents: 1000 }])),
      entry(
        sale('b', 'm2', [
          {
            method: 'CASH',
            amountCents: 1000,
            tenderedCents: 1200,
            changeCents: 200,
            changeToWallet: true,
          },
        ]),
      ),
    ];
    expect(pendingWalletMoves(outbox, null, household)).toEqual([
      { householdId: 'h1', amountCents: -1000 },
      { householdId: 'h1', amountCents: 200 },
    ]);
  });

  it('ignores rejected operations and those already in the last snapshot', () => {
    const outbox = [
      entry(sale('a', 'm1', [{ method: 'WALLET', amountCents: 1000 }]), { status: 'REJECTED' }),
      entry(sale('b', 'm1', [{ method: 'WALLET', amountCents: 500 }]), {
        status: 'DONE',
        syncedAt: '2026-10-03T10:00:00Z',
      }),
      entry(sale('c', 'm1', [{ method: 'WALLET', amountCents: 300 }]), {
        status: 'DONE',
        syncedAt: '2026-10-03T10:10:00Z',
      }),
    ];
    expect(pendingWalletMoves(outbox, '2026-10-03T10:05:00Z', household)).toEqual([
      { householdId: 'h1', amountCents: -300 },
    ]);
  });
});

describe('back-off (R-OFF-03)', () => {
  it('doubles up to two minutes', () => {
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([2000, 4000, 8000, 120_000]);
  });
});
