import { describe, expect, it } from 'vitest';
import {
  PRODUCT_STATUSES,
  PRODUCT_STATUS_LABELS,
  QUALITIES,
  QUALITY_LABELS,
  SALE_CONDITIONS,
  SALE_CONDITION_LABELS,
  SALE_MODES,
  SALE_MODE_LABELS,
  UNITS,
  UNIT_LABELS,
  WALLET_ENTRY_KINDS,
  WALLET_ENTRY_KIND_LABELS,
  MEMBER_PAYMENT_PURPOSES,
  MEMBER_PAYMENT_PURPOSE_LABELS,
  PRODUCT_KINDS,
  PRODUCT_KIND_LABELS,
  pricePerKgOrLitreCents,
} from './catalog';
import { MEMBER_STATUSES, MEMBER_STATUS_LABELS, memberStatusFromLegacy } from './api';

describe('catalogue labels', () => {
  it.each([
    [PRODUCT_KINDS, PRODUCT_KIND_LABELS],
    [SALE_MODES, SALE_MODE_LABELS],
    [UNITS, UNIT_LABELS],
    [SALE_CONDITIONS, SALE_CONDITION_LABELS],
    [PRODUCT_STATUSES, PRODUCT_STATUS_LABELS],
    [QUALITIES, QUALITY_LABELS],
    [WALLET_ENTRY_KINDS, WALLET_ENTRY_KIND_LABELS],
    [MEMBER_PAYMENT_PURPOSES, MEMBER_PAYMENT_PURPOSE_LABELS],
    [MEMBER_STATUSES, MEMBER_STATUS_LABELS],
  ] as [readonly string[], Record<string, string>][])('every code has a label', (codes, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...codes].sort());
    for (const c of codes) expect(labels[c]).toBeTruthy();
  });
});

describe('pricePerKgOrLitreCents (R-PRD-04)', () => {
  it('converts grams to kg', () => {
    // 2.00 € for 250 g → 8.00 €/kg
    expect(pricePerKgOrLitreCents(200, 250_000, 'G')).toBe(800);
  });
  it('converts millilitres to litres', () => {
    expect(pricePerKgOrLitreCents(150, 500_000, 'ML')).toBe(300);
  });
  it('keeps kg and litre units', () => {
    // unit qty is in thousandths of the unit: 500 = 0.5 kg; 250000 = 250 g
    expect(pricePerKgOrLitreCents(300, 500, 'KG')).toBe(600);
    expect(pricePerKgOrLitreCents(300, 1000, 'L')).toBe(300);
  });
  it('rounds to the cent', () => {
    expect(pricePerKgOrLitreCents(100, 300_000, 'G')).toBe(333);
  });
  it('returns null when not applicable', () => {
    expect(pricePerKgOrLitreCents(100, 250_000, null)).toBeNull();
    expect(pricePerKgOrLitreCents(100, 0, 'G')).toBeNull();
    expect(pricePerKgOrLitreCents(100, -5, 'G')).toBeNull();
  });
});

describe('memberStatusFromLegacy (§6.3)', () => {
  it('maps 0–3', () => {
    expect([0, 1, 2, 3].map(memberStatusFromLegacy)).toEqual([
      'NEW',
      'ACTIVE',
      'INACTIVE',
      'ARCHIVED',
    ]);
  });
  it('returns null outside the range', () => {
    expect(memberStatusFromLegacy(null)).toBeNull();
    expect(memberStatusFromLegacy(undefined)).toBeNull();
    expect(memberStatusFromLegacy(4)).toBeNull();
    expect(memberStatusFromLegacy(-1)).toBeNull();
  });
});
