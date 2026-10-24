import { describe, expect, it } from 'vitest';
import {
  bulkPriceImpact,
  cashGapNeedsComment,
  clockSkew,
  DEFAULT_THRESHOLDS,
  inventoryImpact,
  memberDuplicates,
  purchasePriceFlag,
  sellsBelowCost,
  similarNames,
  suggestEmailDomain,
  ticketWarnings,
  tillHealth,
  walletMoveNeedsConfirm,
  type TillHealthInput,
  type WarnLine,
} from './controls';

const line = (over: Partial<WarnLine> = {}): WarnLine => ({
  label: 'Lentilles',
  qtyMilli: 1000,
  unitPriceCents: 250,
  catalogPriceCents: 250,
  discountCents: 0,
  ...over,
});

const codes = (l: WarnLine[], change = 0) => ticketWarnings(l, change).map((w) => w.code);

describe('ticketWarnings', () => {
  it('says nothing about a normal ticket', () => {
    expect(codes([line(), line({ label: 'Riz', qtyMilli: 2000 })])).toEqual([]);
  });
  it('flags a typed 100 instead of 10', () => {
    expect(codes([line({ qtyMilli: 100_000 })])).toContain('QTY_HIGH');
    expect(codes([line({ qtyMilli: 50_000 })])).not.toContain('QTY_HIGH');
  });
  it('flags a large line and a large ticket', () => {
    expect(codes([line({ unitPriceCents: 20_000, catalogPriceCents: 20_000 })])).toContain(
      'LINE_AMOUNT',
    );
    const many = Array.from({ length: 4 }, () =>
      line({ unitPriceCents: 10_000, catalogPriceCents: 10_000 }),
    );
    expect(codes(many)).toContain('TICKET_AMOUNT');
  });
  it('flags a price far from the catalogue, or at zero', () => {
    expect(codes([line({ unitPriceCents: 25 })])).toContain('PRICE_FAR');
    expect(codes([line({ unitPriceCents: 500 })])).toContain('PRICE_FAR');
    expect(codes([line({ unitPriceCents: 300 })])).not.toContain('PRICE_FAR');
    expect(codes([line({ unitPriceCents: 0 })])).toEqual(['PRICE_ZERO']);
  });
  it('leaves a donation (catalogue price 0) alone', () => {
    expect(codes([line({ label: 'Don', catalogPriceCents: 0, unitPriceCents: 5 })])).toEqual([]);
  });
  it('flags a high discount and a high change', () => {
    expect(codes([line({ qtyMilli: 4000, discountCents: 400 })])).toContain('DISCOUNT_HIGH');
    expect(codes([line({ qtyMilli: 4000, discountCents: 100 })])).not.toContain('DISCOUNT_HIGH');
    expect(codes([line()], 6000)).toContain('CHANGE_HIGH');
    expect(codes([line()], 4000)).not.toContain('CHANGE_HIGH');
  });
  it('points at the line concerned, in plain French', () => {
    const [w] = ticketWarnings([line(), line({ label: 'Riz', qtyMilli: 99_000 })], 0);
    expect(w).toMatchObject({ code: 'QTY_HIGH', line: 1 });
    expect(w!.message).toContain('Riz');
    expect(w!.message).not.toMatch(/R-[A-Z]{3}-\d/);
  });
  it('respects custom thresholds', () => {
    const t = { ...DEFAULT_THRESHOLDS, qtyMax: 5 };
    expect(ticketWarnings([line({ qtyMilli: 6000 })], 0, t).map((w) => w.code)).toContain(
      'QTY_HIGH',
    );
  });
});

describe('clockSkew', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  it('accepts a normal clock', () => {
    expect(clockSkew(new Date('2026-10-24T11:50:00Z'), now)).toBeNull();
    expect(clockSkew(new Date('2026-10-24T12:05:00Z'), now)).toBeNull();
  });
  it('flags a clock ahead or far behind', () => {
    expect(clockSkew(new Date('2026-10-24T12:30:00Z'), now)).toBe('FUTURE');
    expect(clockSkew(new Date('2026-10-20T12:00:00Z'), now)).toBe('PAST');
    expect(clockSkew(new Date('2026-10-22T12:00:00Z'), now)).toBeNull();
  });
});

describe('tillHealth', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const base: TillHealthInput = {
    online: true,
    lastContactAt: ago(1),
    oldestPendingAt: null,
    sessionOpenedAt: ago(60),
  };
  const codes = (s: Partial<TillHealthInput>) =>
    tillHealth(now, { ...base, ...s }).map((w) => w.code);

  it('is quiet when all is well', () => expect(codes({})).toEqual([]));
  it('flags a till offline for too long', () => {
    expect(codes({ online: false, lastContactAt: ago(10) })).toEqual([]);
    expect(codes({ online: false, lastContactAt: ago(45) })).toEqual(['OFFLINE_LONG']);
    expect(codes({ online: false, lastContactAt: null })).toEqual(['OFFLINE_LONG']);
  });
  it('flags stale data while online', () => {
    expect(codes({ lastContactAt: ago(90) })).toEqual(['SNAPSHOT_OLD']);
  });
  it('flags a ticket waiting too long, and an old session', () => {
    expect(codes({ oldestPendingAt: ago(5) })).toEqual([]);
    expect(codes({ oldestPendingAt: ago(20) })).toEqual(['PENDING_OLD']);
    expect(codes({ sessionOpenedAt: ago(25 * 60) })).toEqual(['SESSION_OLD']);
  });
});

describe('cash closing', () => {
  it('asks for a comment only above the threshold, either way', () => {
    expect(cashGapNeedsComment(0)).toBe(false);
    expect(cashGapNeedsComment(500)).toBe(false);
    expect(cashGapNeedsComment(501)).toBe(true);
    expect(cashGapNeedsComment(-1200)).toBe(true);
  });
});

describe('purchase price and margin', () => {
  it('flags a purchase price that jumped', () => {
    expect(purchasePriceFlag(20_000, 20_500)).toEqual({ flagged: false, pct: 2.5 });
    expect(purchasePriceFlag(20_000, 30_000).flagged).toBe(true);
    expect(purchasePriceFlag(20_000, 10_000).flagged).toBe(true);
    expect(purchasePriceFlag(null, 30_000)).toEqual({ flagged: false, pct: null });
    expect(purchasePriceFlag(0, 30_000).flagged).toBe(false);
  });
  it('detects a selling price below the purchase price', () => {
    expect(sellsBelowCost(300, 350)).toBe(true);
    expect(sellsBelowCost(350, 350)).toBe(false);
    expect(sellsBelowCost(100, null)).toBe(false);
    expect(sellsBelowCost(0, 0)).toBe(false);
  });
});

describe('inventoryImpact', () => {
  it('flags the lines far from the theory, adds the value of the gaps, counts the zeroed ones', () => {
    const r = inventoryImpact(
      [
        { theoreticalMilli: 10_000, countedMilli: 10_000, unitCostCents: 200 }, // equal
        { theoreticalMilli: 10_000, countedMilli: 9_000, unitCostCents: 200 }, // 10 %: fine
        { theoreticalMilli: 10_000, countedMilli: 4_000, unitCostCents: 200 }, // 60 %: flagged
        { theoreticalMilli: 2_000, countedMilli: null, unitCostCents: 300 }, // not counted
        { theoreticalMilli: 0, countedMilli: null, unitCostCents: 300 }, // nothing to zero
      ],
      true,
    );
    expect(r.flagged).toEqual([2]);
    expect(r.totalGapCents).toBe(200 + 1200);
    expect(r.willBeZeroed).toBe(1);
    expect(r.totalFlagged).toBe(false);
  });
  it('flags a line by value and the total', () => {
    const r = inventoryImpact(
      [{ theoreticalMilli: 1_000_000, countedMilli: 980_000, unitCostCents: 500 }],
      false,
    );
    expect(r.flagged).toEqual([0]); // 20 units × 5 € = 100 € > 50 €
    expect(r.totalFlagged).toBe(false);
    const big = inventoryImpact(
      [{ theoreticalMilli: 100_000, countedMilli: 0, unitCostCents: 500 }],
      false,
    );
    expect(big.totalFlagged).toBe(true);
  });
  it('does not zero anything unless asked', () => {
    expect(
      inventoryImpact([{ theoreticalMilli: 5000, countedMilli: null, unitCostCents: 100 }], false)
        .willBeZeroed,
    ).toBe(0);
  });
});

describe('walletMoveNeedsConfirm', () => {
  it('uses a higher limit for a top-up than for a correction', () => {
    expect(walletMoveNeedsConfirm('TOPUP', 15_000)).toBe(false);
    expect(walletMoveNeedsConfirm('TOPUP', 25_000)).toBe(true);
    expect(walletMoveNeedsConfirm('CORRECTION', -6_000)).toBe(true);
    expect(walletMoveNeedsConfirm('CORRECTION', 4_000)).toBe(false);
  });
});

describe('similarNames', () => {
  const existing = ['Lentilles vertes du Puy', 'Riz basmati', 'Miel de fleurs'];
  it('finds the same name once accents and case are ignored', () => {
    expect(similarNames('LENTILLES VERTES DU PUY', existing)).toEqual(['Lentilles vertes du Puy']);
    expect(similarNames('Miel de fleûrs', existing)).toEqual(['Miel de fleurs']);
  });
  it('finds a name one or two letters off', () => {
    expect(similarNames('Riz basmatti', existing)).toEqual(['Riz basmati']);
    expect(similarNames('Lentilles vertes du Pui', existing)).toEqual(['Lentilles vertes du Puy']);
  });
  it('leaves clearly different or very short names alone', () => {
    expect(similarNames('Riz complet', existing)).toEqual([]);
    expect(similarNames('Pâtes', existing)).toEqual([]);
    expect(similarNames('Ri', existing)).toEqual([]);
  });
});

describe('suggestEmailDomain', () => {
  it('corrects a typo in a common domain', () => {
    expect(suggestEmailDomain('marie@gmial.com')).toBe('marie@gmail.com');
    expect(suggestEmailDomain('marie@hotmial.fr')).toBe('marie@hotmail.fr');
    expect(suggestEmailDomain('marie@orange.frr')).toBe('marie@orange.fr');
  });
  it('says nothing about a good or unknown domain', () => {
    expect(suggestEmailDomain('marie@gmail.com')).toBeNull();
    expect(suggestEmailDomain('marie@mairie-montjavoult.fr')).toBeNull();
    expect(suggestEmailDomain('pas-un-courriel')).toBeNull();
  });
});

describe('memberDuplicates', () => {
  const others = [
    { id: '1', firstName: 'Marie', lastName: 'Dupont', phone: '06 12 34 56 78', email: null },
    { id: '2', firstName: 'Jean', lastName: 'Martin', phone: '01 23 45 67 89', email: null },
  ];
  it('finds the same person by name, accents and case ignored', () => {
    const r = memberDuplicates(
      { firstName: 'marie', lastName: 'DUPONT', phone: null, email: null },
      others,
    );
    expect(r.map((m) => m.id)).toEqual(['1']);
  });
  it('finds the same phone number whatever its format', () => {
    const r = memberDuplicates(
      { firstName: 'Paul', lastName: 'Autre', phone: '+33 6 12 34 56 78', email: null },
      others,
    );
    expect(r.map((m) => m.id)).toEqual(['1']);
  });
  it('ignores the member being edited and short numbers', () => {
    expect(
      memberDuplicates(
        { id: '1', firstName: 'Marie', lastName: 'Dupont', phone: '06 12 34 56 78', email: null },
        others,
      ),
    ).toEqual([]);
    expect(
      memberDuplicates({ firstName: 'X', lastName: 'Y', phone: '1234', email: null }, [
        { firstName: 'A', lastName: 'B', phone: '1234', email: null },
      ]),
    ).toEqual([]);
  });
});

describe('bulkPriceImpact', () => {
  const base = {
    oldSaleCents: 200,
    newSaleCents: 200,
    newPurchase4: 10_000,
    vatRate: '5.50',
    wasActive: true,
    active: true,
  };
  it('sums up a harmless grid', () => {
    const r = bulkPriceImpact([base, { ...base, newSaleCents: 210 }]);
    expect(r).toMatchObject({ count: 2, bigJumps: 0, belowCost: 0, saleZero: 0, deactivated: 0 });
    expect(r.avgSalePct).toBeCloseTo(2.5);
    expect(r.maxSalePct).toBeCloseTo(5);
  });
  it('counts the big jumps, a price at 0 €, a sale below cost and the deactivations', () => {
    const r = bulkPriceImpact([
      { ...base, newSaleCents: 500 }, // +150 %
      { ...base, newSaleCents: 0 }, // free (and below cost)
      { ...base, newSaleCents: 90 }, // −55 %, and 1 € HT + 5.5 % = 1.06 €: below cost
      { ...base, active: false },
    ]);
    expect(r).toMatchObject({ bigJumps: 3, saleZero: 1, belowCost: 2, deactivated: 1, count: 4 });
    expect(r.maxSalePct).toBeCloseTo(150);
  });
  it('has nothing to average when the old prices are unknown', () => {
    const r = bulkPriceImpact([{ ...base, oldSaleCents: null }]);
    expect(r.avgSalePct).toBeNull();
    expect(r.maxSalePct).toBeNull();
  });
  it('is empty for no change', () => {
    expect(bulkPriceImpact([])).toMatchObject({ count: 0, avgSalePct: null, bigJumps: 0 });
  });
});
