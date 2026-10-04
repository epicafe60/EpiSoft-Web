import { describe, expect, it } from 'vitest';
import { saleOpSchema, syncOpSchema, syncPushSchema } from './sync';

const id = () => crypto.randomUUID();
const sale = () => ({
  id: id(),
  deviceSeq: 1,
  kind: 'SALE' as const,
  payload: {
    sessionId: id(),
    cashierId: id(),
    memberId: null,
    soldAt: '2026-10-01T10:00:00+02:00',
    provisionalNumber: 'P-1',
    lines: [{ productId: id(), label: 'Pâtes', qty: '2.000', unitPrice: '1.50', catalogPrice: '1.50', discount: '0.00' }],
    payments: [{ method: 'CASH' as const, amount: '3.00' }],
    total: '3.00',
  },
});

describe('sync operations (R-SYNC)', () => {
  it('accepts a valid sale and applies defaults', () => {
    const r = saleOpSchema.parse(sale());
    expect(r.payload.emailReceipt).toBe(false);
  });
  it('rejects a sale without line or payment', () => {
    const a = sale();
    expect(saleOpSchema.safeParse({ ...a, payload: { ...a.payload, lines: [] } }).success).toBe(false);
    expect(saleOpSchema.safeParse({ ...a, payload: { ...a.payload, payments: [] } }).success).toBe(false);
  });
  it('rejects amounts with more than 2 decimals and quantities with more than 3', () => {
    const a = sale();
    expect(saleOpSchema.safeParse({ ...a, payload: { ...a.payload, total: '3.001' } }).success).toBe(false);
    const l = { ...a.payload.lines[0]!, qty: '1.0001' };
    expect(saleOpSchema.safeParse({ ...a, payload: { ...a.payload, lines: [l] } }).success).toBe(false);
  });
  it('rejects bad ids, sequence numbers and dates', () => {
    const a = sale();
    expect(saleOpSchema.safeParse({ ...a, id: 'nope' }).success).toBe(false);
    expect(saleOpSchema.safeParse({ ...a, deviceSeq: 0 }).success).toBe(false);
    expect(saleOpSchema.safeParse({ ...a, payload: { ...a.payload, soldAt: '2026-10-01' } }).success).toBe(false);
  });
  it('discriminates on kind', () => {
    expect(syncOpSchema.safeParse({ ...sale(), kind: 'UNKNOWN' }).success).toBe(false);
    const open = {
      id: id(),
      deviceSeq: 2,
      kind: 'SESSION_OPEN',
      payload: { sessionId: id(), openedBy: id(), openedAt: '2026-10-01T08:00:00Z', openingFloat: '50.00' },
    };
    expect(syncOpSchema.parse(open).kind).toBe('SESSION_OPEN');
    const topup = {
      id: id(),
      deviceSeq: 3,
      kind: 'WALLET_TOPUP',
      payload: { sessionId: id(), cashierId: id(), householdId: id(), amount: '20.00', method: 'CASH', at: '2026-10-01T09:00:00Z' },
    };
    expect(syncOpSchema.parse(topup).kind).toBe('WALLET_TOPUP');
    expect(syncOpSchema.safeParse({ ...topup, payload: { ...topup.payload, method: 'WALLET' } }).success).toBe(false);
    const cancel = { id: id(), deviceSeq: 4, kind: 'SALE_CANCEL', payload: { cancelSaleId: id(), saleId: id(), sessionId: id(), cashierId: id(), at: '2026-10-01T09:30:00Z', provisionalNumber: 'A-1' } };
    expect(syncOpSchema.parse(cancel).kind).toBe('SALE_CANCEL');
  });
  it('bounds a push batch', () => {
    expect(syncPushSchema.safeParse({ deviceId: id(), ops: [] }).success).toBe(false);
    expect(syncPushSchema.safeParse({ deviceId: id(), ops: [sale()] }).success).toBe(true);
    const many = Array.from({ length: 201 }, sale);
    expect(syncPushSchema.safeParse({ deviceId: id(), ops: many }).success).toBe(false);
  });
});
