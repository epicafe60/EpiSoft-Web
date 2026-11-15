import { describe, expect, it } from 'vitest';
import { operationTotals, type OperationRow, type SyncOp } from '@episoft/shared';
import type { OutboxEntry } from './db';
import { cancelledSaleIds, localOperations, mergeOperations } from './operations-rows';

const SESSION = '00000000-0000-4000-8000-000000000001';
const CASHIER = '00000000-0000-4000-8000-0000000000c1';
const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const HOUSEHOLD = '00000000-0000-4000-8000-0000000000b1';
const P_GOODS = '00000000-0000-4000-8000-0000000000f1';
const P_DON = '00000000-0000-4000-8000-0000000000f2';
const P_ADH = '00000000-0000-4000-8000-0000000000f3';

const products = [
  { id: P_GOODS, code: '10001' },
  { id: P_DON, code: '01004' },
  { id: P_ADH, code: '01001' },
];
const membershipTypes = [{ productId: P_ADH }];
const members = [
  { id: CASHIER, firstName: 'Camille', lastName: 'CAISSE', householdId: null, number: 1 },
  { id: MEMBER, firstName: 'Anne', lastName: 'FOYER', householdId: HOUSEHOLD, number: 2 },
];

const entry = (op: SyncOp, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: op.id,
  seq: op.deviceSeq,
  kind: op.kind,
  op,
  status: 'PENDING',
  createdAt: '2026-11-15T10:00:00.000Z',
  attempts: 0,
  lastError: null,
  syncedAt: null,
  result: null,
  ...over,
});

const line = (productId: string, unitPrice: string, qty = '1') => ({
  productId,
  label: 'x',
  qty,
  unitPrice,
  catalogPrice: unitPrice,
  discount: '0',
});

/** 2 goods + 1.50 donation + 12 membership = 16; 10 from the cagnotte, 6 in cash with 4 of change into it. */
const ticket = (id: string, soldAt = '2026-11-15T10:00:00.000Z'): SyncOp => ({
  kind: 'SALE',
  id,
  deviceSeq: 2,
  payload: {
    sessionId: SESSION,
    cashierId: CASHIER,
    memberId: MEMBER,
    soldAt,
    provisionalNumber: 'CAISSE1-2',
    lines: [line(P_GOODS, '1.25', '2'), line(P_DON, '1.50'), line(P_ADH, '12.00')],
    payments: [
      { method: 'WALLET', amount: '10.00' },
      { method: 'CASH', amount: '6.00', tendered: '10.00', change: '4.00', changeToWallet: true },
    ],
    total: '16.00',
    emailReceipt: false,
  },
});

const topup: SyncOp = {
  kind: 'WALLET_TOPUP',
  id: '00000000-0000-4000-8000-0000000000d1',
  deviceSeq: 3,
  payload: {
    sessionId: SESSION,
    cashierId: CASHIER,
    householdId: HOUSEHOLD,
    amount: '20.00',
    method: 'CHEQUE',
    at: '2026-11-15T11:00:00.000Z',
    emailReceipt: false,
  },
};

const build = (entries: OutboxEntry[], scope = { sessionId: SESSION } as never) =>
  localOperations({ entries, products, membershipTypes, members, scope });

describe('localOperations (R-VTE-12, R-CAG-05)', () => {
  it('computes don, adhésion, cagnotte movement and the change of a ticket', () => {
    const [r] = build([entry(ticket('11111111-1111-4111-8111-111111111111'))]);
    expect(r).toMatchObject({
      origin: 'LOCAL',
      type: 'SALE',
      number: 'CAISSE1-2',
      cashierName: 'Camille CAISSE',
      memberName: 'Anne FOYER',
      total: '16.00',
      donation: '1.50',
      membership: '12.00',
      wallet: '-6.00',
      walletCash: '4.00',
      cancelled: false,
      sync: 'PENDING',
    });
  });

  it('gives a top-up the cagnotte movement and the household member', () => {
    const [r] = build([entry(topup)]);
    expect(r).toMatchObject({
      type: 'TOPUP',
      number: null,
      total: '20.00',
      wallet: '20.00',
      memberName: 'Anne FOYER',
      payments: [{ method: 'CHEQUE', amount: '20.00' }],
    });
  });

  it('shows the final number once sent, and the state of a refused ticket', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const [sent] = build([
      entry(ticket(id), {
        status: 'DONE',
        result: { id, status: 'OK', number: 'T-2026-0042', warnings: [] },
      }),
    ]);
    expect(sent).toMatchObject({ number: 'T-2026-0042', sync: 'SENT' });
    const [refused] = build([
      entry(ticket(id), { status: 'REJECTED', lastError: 'Stock', acknowledged: true }),
    ]);
    expect(refused).toMatchObject({ sync: 'REJECTED', error: 'Stock', acknowledged: true });
  });

  it('marks a cancelled ticket, but not when the cancellation was refused', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const cancel = (status: OutboxEntry['status']) =>
      entry(
        {
          kind: 'SALE_CANCEL',
          id: '22222222-2222-4222-8222-222222222222',
          deviceSeq: 4,
          payload: {
            cancelSaleId: '33333333-3333-4333-8333-333333333333',
            saleId: id,
            sessionId: SESSION,
            cashierId: CASHIER,
            at: '2026-11-15T12:00:00.000Z',
            provisionalNumber: 'CAISSE1-4',
          },
        },
        { status },
      );
    expect(build([entry(ticket(id)), cancel('PENDING')])).toHaveLength(1);
    expect(build([entry(ticket(id)), cancel('PENDING')])[0]!.cancelled).toBe(true);
    expect(build([entry(ticket(id)), cancel('REJECTED')])[0]!.cancelled).toBe(false);
    expect([...cancelledSaleIds([cancel('DONE')])]).toEqual([id]);
  });

  it('keeps the operations of the session, or of the day', () => {
    const other = ticket('44444444-4444-4444-8444-444444444444', '2026-11-14T10:00:00.000Z');
    if (other.kind === 'SALE') other.payload.sessionId = '00000000-0000-4000-8000-0000000000ee';
    const entries = [entry(ticket('11111111-1111-4111-8111-111111111111')), entry(other)];
    expect(build(entries)).toHaveLength(1);
    expect(build(entries, { day: '2026-11-15' } as never)).toHaveLength(1);
    expect(build(entries, { day: '2026-11-14' } as never)).toHaveLength(1);
    expect(build(entries, { day: '2026-11-13' } as never)).toHaveLength(0);
  });

  it('adds up like the server would', () => {
    const rows = build([entry(ticket('11111111-1111-4111-8111-111111111111')), entry(topup)]);
    expect(operationTotals(rows)).toMatchObject({
      sales: '16.00',
      payments: '20.00',
      donation: '1.50',
      membership: '12.00',
      wallet: '14.00',
      byMethod: { CASH: '10.00', WALLET: '10.00', CHEQUE: '20.00' },
    });
  });
});

describe('mergeOperations (R-OFF-02)', () => {
  const server = (over: Partial<OperationRow>): OperationRow => ({
    id: 's',
    origin: 'SERVER',
    type: 'SALE',
    at: '2026-11-15T09:00:00.000Z',
    number: 'T-1',
    cashierName: 'Autre',
    deviceName: 'CAISSE2',
    memberName: null,
    payments: [{ method: 'CASH', amount: '5.00' }],
    total: '5.00',
    donation: '0.00',
    membership: '0.00',
    wallet: '0.00',
    walletCash: '0.00',
    cancelled: false,
    sync: 'SENT',
    error: null,
    ...over,
  });

  it('takes the server rows as the base and adds what is waiting or refused, once', () => {
    const idSent = '11111111-1111-4111-8111-111111111111';
    const idPending = '55555555-5555-4555-8555-555555555555';
    const local = build([
      entry(ticket(idSent), { status: 'DONE' }),
      entry(ticket(idPending, '2026-11-15T13:00:00.000Z')),
      entry(topup, { status: 'REJECTED', lastError: 'Foyer inconnu' }),
    ]);
    const merged = mergeOperations(
      [server({ id: 's' }), server({ id: idSent, number: 'T-2', at: '2026-11-15T10:00:00.000Z' })],
      local,
      new Set(),
    );
    expect(merged.map((r) => r.id)).toEqual([idPending, topup.id, idSent, 's']);
    expect(merged.find((r) => r.id === idSent)!.origin).toBe('SERVER');
    // the pending ticket is also on the server: listed once
    const again = mergeOperations([server({ id: idPending })], local, new Set());
    expect(again.filter((r) => r.id === idPending)).toHaveLength(1);
    expect(again.find((r) => r.id === idPending)!.origin).toBe('SERVER');
  });

  it('keeps a sent top-up until the server lists the same one, whatever its id', () => {
    const local = build([entry(topup, { status: 'DONE' })]);
    const row = local[0]!;
    const other = server({ id: 's' });
    // Sent, but the server's list is not refreshed yet: still shown.
    expect(mergeOperations([other], local, new Set()).map((r) => r.id)).toContain(topup.id);
    // The server lists it (other id, same amount, same moment): shown once.
    const listed = server({ id: 'pay-1', type: 'TOPUP', total: row.total, at: row.at });
    const merged = mergeOperations([other, listed], local, new Set());
    expect(merged.map((r) => r.id)).not.toContain(topup.id);
    expect(merged.map((r) => r.id)).toContain('pay-1');
  });

  it('shows a ticket cancelled at this till as cancelled before the server knows', () => {
    const merged = mergeOperations([server({ id: 's' })], [], new Set(['s']));
    expect(merged[0]!.cancelled).toBe(true);
  });

  it('offline: only the till’s own rows', () => {
    const local = build([
      entry(ticket('11111111-1111-4111-8111-111111111111'), { status: 'DONE' }),
    ]);
    expect(mergeOperations(undefined, local, new Set())).toHaveLength(1);
  });
});
