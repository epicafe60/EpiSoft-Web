import { describe, expect, it } from 'vitest';
import { allocationLines, allocationTotals } from './allocations';
import type { OperationRow } from './operations';

// R-CPT-20: the extract of the accounting allocations.

const op = (over: Partial<OperationRow>): OperationRow => ({
  id: 'x',
  origin: 'SERVER',
  type: 'SALE',
  at: '2026-04-10T10:00:00.000Z',
  number: 'T-2026-000001',
  cashierName: 'Camille CAISSE',
  deviceName: 'CAISSE1',
  memberName: 'Anne FOYER',
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

describe('allocationLines (R-CPT-20)', () => {
  it('splits a ticket into donation, membership and purchase; the total is E + F + H', () => {
    const [l] = allocationLines({
      operations: [op({ id: 'a', total: '16.00', donation: '1.50', membership: '12.00' })],
    });
    expect(l).toMatchObject({
      label: 'Ticket n° T-2026-000001',
      who: 'Anne FOYER',
      mode: 'Espèces',
      donCents: 150,
      adhCents: 1200,
      cagCents: 0,
      achatCents: 250,
      totalCents: 1600,
    });
    expect(l!.donCents + l!.adhCents + l!.achatCents).toBe(l!.totalCents);
  });

  it('names a ticket without a member « adhérent de passage », and spells out a mixed payment', () => {
    const [l] = allocationLines({
      operations: [
        op({
          id: 'a',
          memberName: null,
          total: '5.35',
          payments: [
            { method: 'CASH', amount: '3.00' },
            { method: 'WALLET', amount: '2.35' },
          ],
        }),
      ],
    });
    expect(l!.who).toBe('Adhérent de passage');
    expect(l!.mode).toContain('Espèces');
    expect(l!.mode).toContain('Cagnotte');
    expect(l!.mode).toMatch(/3,00/);
    expect(l!.mode).toMatch(/2,35/);
  });

  it('keeps a top-up out of the total, and shows the change paid into the cagnotte on its ticket', () => {
    const lines = allocationLines({
      operations: [
        op({
          id: 't',
          type: 'TOPUP',
          number: null,
          total: '20.00',
          payments: [{ method: 'CHEQUE', amount: '20.00' }],
          wallet: '20.00',
        }),
        op({
          id: 's',
          total: '6.00',
          walletCash: '4.00',
          payments: [{ method: 'CASH', amount: '6.00' }],
        }),
      ],
    });
    const topup = lines.find((l) => l.id === 't')!;
    expect(topup).toMatchObject({
      label: 'Versement sur cagnotte',
      cagCents: 2000,
      totalCents: 0,
      mode: 'Chèque',
    });
    const sale = lines.find((l) => l.id === 's')!;
    expect(sale).toMatchObject({ cagCents: 400, achatCents: 600, totalCents: 600 });
  });

  it('lists the payments made outside a ticket', () => {
    const lines = allocationLines({
      operations: [
        op({
          id: 'm',
          type: 'MEMBERSHIP_PAYMENT',
          number: null,
          total: '12.00',
          membership: '12.00',
        }),
        op({ id: 'd', type: 'DONATION_PAYMENT', number: null, total: '38.00', donation: '38.00' }),
      ],
    });
    expect(lines.find((l) => l.id === 'm')).toMatchObject({
      label: 'Adhésion',
      adhCents: 1200,
      totalCents: 1200,
    });
    expect(lines.find((l) => l.id === 'd')).toMatchObject({
      label: 'Don',
      donCents: 3800,
      totalCents: 3800,
    });
  });

  it('leaves a cancelled ticket out, but keeps its change paid into the cagnotte', () => {
    const lines = allocationLines({
      operations: [
        op({ id: 'c', total: '6.00', cancelled: true }),
        op({
          id: 'c:change',
          type: 'TOPUP',
          number: null,
          total: '4.00',
          wallet: '4.00',
          payments: [{ method: 'CASH', amount: '4.00' }],
        }),
      ],
    });
    expect(lines.map((l) => l.id)).toEqual(['c:change']);
    expect(lines[0]!.cagCents).toBe(400);
  });

  it('turns the cagnotte movements without ticket into purchases (debits) and corrections', () => {
    const lines = allocationLines({
      operations: [],
      movements: [
        {
          id: 'p',
          at: '2026-03-02T00:00:00.000Z',
          kind: 'PURCHASE',
          amount: '-12.40',
          comment: null,
          memberName: 'Anne FOYER',
        },
        {
          id: 'k',
          at: '2026-03-03T00:00:00.000Z',
          kind: 'CORRECTION',
          amount: '5.00',
          comment: 'Erreur de saisie',
          memberName: null,
        },
      ],
    });
    expect(lines[0]).toMatchObject({
      label: 'Achats réglés par la cagnotte',
      mode: 'Cagnotte',
      achatCents: 1240,
      totalCents: 1240,
    });
    expect(lines[1]).toMatchObject({
      label: 'Correction de cagnotte',
      cagCents: 500,
      totalCents: 0,
      note: 'Erreur de saisie',
    });
  });

  it('sorts oldest first and adds up', () => {
    const lines = allocationLines({
      operations: [
        op({ id: 'b', at: '2026-04-11T10:00:00.000Z', total: '3.00' }),
        op({ id: 'a', at: '2026-04-10T10:00:00.000Z', total: '2.00' }),
      ],
    });
    expect(lines.map((l) => l.id)).toEqual(['a', 'b']);
    expect(allocationTotals(lines)).toEqual({
      count: 2,
      don: '0.00',
      adh: '0.00',
      cag: '0.00',
      achat: '5.00',
      total: '5.00',
    });
  });
});
