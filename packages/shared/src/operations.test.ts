import { describe, expect, it } from 'vitest';
import {
  filterOperations,
  operationTotals,
  operationTypeOfPurpose,
  paymentsLabel,
  saleOperationAmounts,
  sortOperations,
  type OperationRow,
} from './operations';

// The operations of a session at the till: what a ticket holds, how rows are added up and filtered.

const row = (over: Partial<OperationRow> = {}): OperationRow => ({
  id: 'x',
  origin: 'SERVER',
  type: 'SALE',
  at: '2026-11-15T10:00:00.000Z',
  number: 'T-1',
  cashierName: 'Marie D.',
  deviceName: null,
  memberName: 'Paul R.',
  payments: [{ method: 'CASH', amount: '10.00' }],
  total: '10.00',
  donation: '0.00',
  membership: '0.00',
  wallet: '0.00',
  walletCash: '0.00',
  cancelled: false,
  sync: 'SENT',
  error: null,
  ...over,
});

describe('what a ticket holds', () => {
  const donation = new Set(['don']);
  const membership = new Set(['adh']);

  it('finds the donation and the membership among the service lines', () => {
    const a = saleOperationAmounts({
      lines: [
        { productId: 'pain', totalCents: 350 },
        { productId: 'don', totalCents: 200 },
        { productId: 'adh', totalCents: 1200 },
        { productId: 'don', totalCents: 100 },
      ],
      payments: [{ method: 'CASH', amountCents: 1850 }],
      donationProductIds: donation,
      membershipProductIds: membership,
    });
    expect(a).toMatchObject({ donationCents: 300, membershipCents: 1200, walletCents: 0 });
  });

  it('takes from the cagnotte what was paid from it, and adds the change paid into it', () => {
    const paid = saleOperationAmounts({
      lines: [{ productId: 'pain', totalCents: 1690 }],
      payments: [
        { method: 'CASH', amountCents: 1000 },
        { method: 'WALLET', amountCents: 690 },
      ],
      donationProductIds: donation,
      membershipProductIds: membership,
    });
    expect(paid.walletCents).toBe(-690);
    const change = saleOperationAmounts({
      lines: [{ productId: 'pain', totalCents: 350 }],
      payments: [{ method: 'CASH', amountCents: 350, changeCents: 150, changeToWallet: true }],
      donationProductIds: donation,
      membershipProductIds: membership,
    });
    // The 1,50 € is cash in the drawer that now belongs to the cagnotte.
    expect(change).toMatchObject({ walletCents: 150, walletCashCents: 150 });
    // Change given back is not a movement of the cagnotte.
    expect(
      saleOperationAmounts({
        lines: [{ productId: 'pain', totalCents: 350 }],
        payments: [{ method: 'CASH', amountCents: 350, changeCents: 150, changeToWallet: false }],
        donationProductIds: donation,
        membershipProductIds: membership,
      }).walletCents,
    ).toBe(0);
  });
});

describe('the type of a payment made outside a ticket', () => {
  it('follows its purpose', () => {
    expect(operationTypeOfPurpose('TOPUP')).toBe('TOPUP');
    expect(operationTypeOfPurpose('MEMBERSHIP')).toBe('MEMBERSHIP_PAYMENT');
    expect(operationTypeOfPurpose('DONATION')).toBe('DONATION_PAYMENT');
    expect(operationTypeOfPurpose('OTHER')).toBe('OTHER_PAYMENT');
  });
});

describe('adding up a session', () => {
  const rows = [
    row({
      payments: [
        { method: 'CASH', amount: '10.00' },
        { method: 'WALLET', amount: '6.90' },
      ],
      total: '16.90',
      donation: '2.00',
      wallet: '-6.90',
    }),
    row({
      type: 'TOPUP',
      number: null,
      payments: [{ method: 'CHEQUE', amount: '20.00' }],
      total: '20.00',
      wallet: '20.00',
    }),
    row({
      payments: [{ method: 'CARD', amount: '14.00' }],
      total: '14.00',
      membership: '2.00',
    }),
    row({
      payments: [{ method: 'CASH', amount: '3.50' }],
      total: '3.50',
      wallet: '1.50',
      walletCash: '1.50',
    }),
  ];

  it('counts what came in by way of payment, the tickets, the payments and the three columns', () => {
    expect(operationTotals(rows)).toEqual({
      count: 4,
      byMethod: { CASH: '15.00', CHEQUE: '20.00', CARD: '14.00', WALLET: '6.90', TRANSFER: '0.00' },
      sales: '34.40',
      payments: '20.00',
      donation: '2.00',
      membership: '2.00',
      wallet: '14.60',
    });
  });

  it('leaves a cancelled operation out of everything', () => {
    const t = operationTotals([
      ...rows,
      row({ cancelled: true, total: '99.00', donation: '5.00' }),
    ]);
    expect(t.count).toBe(4);
    expect(t.sales).toBe('34.40');
    expect(t.donation).toBe('2.00');
  });

  it('is empty for no operation', () => {
    expect(operationTotals([])).toMatchObject({ count: 0, sales: '0.00', wallet: '0.00' });
  });
});

describe('filtering and sorting', () => {
  const rows = [
    row({ id: '1', number: 'T-1', cashierName: 'Marie D.', memberName: 'Zoé Éloi' }),
    row({
      id: '2',
      type: 'TOPUP',
      number: null,
      cashierName: 'Luc P.',
      memberName: 'Anne L.',
      payments: [{ method: 'CHEQUE', amount: '20.00' }],
    }),
  ];

  it('by type, cashier and way of payment', () => {
    expect(filterOperations(rows, { type: 'TOPUP' }).map((r) => r.id)).toEqual(['2']);
    expect(filterOperations(rows, { cashier: 'Marie D.' }).map((r) => r.id)).toEqual(['1']);
    expect(filterOperations(rows, { method: 'CHEQUE' }).map((r) => r.id)).toEqual(['2']);
    expect(filterOperations(rows, { type: '', method: '' })).toHaveLength(2);
  });

  it('by text, without caring for case or accents', () => {
    expect(filterOperations(rows, { q: 'eloi' }).map((r) => r.id)).toEqual(['1']);
    expect(filterOperations(rows, { q: 'T-1' }).map((r) => r.id)).toEqual(['1']);
    expect(filterOperations(rows, { q: 'luc' }).map((r) => r.id)).toEqual(['2']);
    expect(filterOperations(rows, { q: 'personne' })).toEqual([]);
  });

  it('puts the most recent first', () => {
    const sorted = sortOperations([
      row({ id: 'a', at: '2026-11-15T09:00:00.000Z' }),
      row({ id: 'b', at: '2026-11-15T11:00:00.000Z' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('writes the payments of a row for a cell', () => {
    expect(
      paymentsLabel(
        [
          { method: 'CASH', amount: '10.00' },
          { method: 'WALLET', amount: '6.90' },
        ],
        (a) => a,
      ),
    ).toBe('Espèces 10.00 · Cagnotte 6.90');
  });
});
