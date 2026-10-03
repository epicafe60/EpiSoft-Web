import { describe, expect, it } from 'vitest';
import {
  fixed,
  legacyCents,
  parseQualities,
  parseTicketPayments,
  planPayment,
  transformProduct,
  type LegacyProductRow,
} from './transform-lot1';

const row = (over: Partial<LegacyProductRow> = {}): LegacyProductRow => ({
  PRODNUM: '111001',
  PRODNOM: "Chips nature à l'ancienne Lays 155g",
  PRODESCR: null,
  PRODTYPVTE: 0,
  PRODQTE: '0.155',
  PRODUNITVTE: 1,
  PRODEAN13: '3168930167983',
  PRODCONDVTE: 2,
  PRODFNR: '0910',
  PRODREFFNR: '',
  PRODUNIV: '1',
  PRODRAY: '11',
  PRODQUALITE: ',0',
  PRODTVATX: '5.50',
  PRODATCREA: '2026-04-21',
  PRODSTATUT: 1,
  PRODPAHT: '1.2000',
  PRODPATTC: '1.2660',
  PRODPRIXVTE: '2.50',
  PRODSTOCK: '-2.000',
  PRODSTKMIN: '3.000',
  PRODPACHG: 1,
  ...over,
});

describe('products (spec §6.3)', () => {
  it('maps codes and prices', () => {
    const { draft, issues } = transformProduct(row());
    expect(issues).toEqual([]);
    expect(draft).toMatchObject({
      kind: 'GOODS',
      saleMode: 'UNIT',
      unit: 'KG',
      saleCondition: 'BOTH',
      status: 'ACTIVE',
      qualities: ['LOCAL'],
      vatRate: '5.50',
      purchasePriceExcl: '1.2000',
      salePrice: '2.50',
      stock: '-2.000',
      labelPending: true,
      ean: '3168930167983',
    });
  });

  it('turns 01xxx codes into services without stock (R-PRD-02)', () => {
    const { draft } = transformProduct(
      row({ PRODNUM: '01002', PRODUNIV: '9', PRODRAY: '9', PRODSTOCK: '-7' }),
    );
    expect(draft).toMatchObject({ kind: 'SERVICE', stock: '0.000', universeCode: null });
  });

  it('retires the legacy cagnotte services', () => {
    expect(transformProduct(row({ PRODNUM: '01010' })).draft.status).toBe('INACTIVE');
  });

  it('reports invalid codes', () => {
    const { draft, issues } = transformProduct(
      row({ PRODTYPVTE: -1, PRODUNITVTE: 4, PRODEAN13: '3168930167984', PRODTVATX: '7.00' }),
    );
    expect(draft).toMatchObject({ saleMode: 'UNIT', unit: null, ean: null, vatRate: '0.00' });
    expect(issues.map((i) => i.field).sort()).toEqual([
      'PRODEAN13',
      'PRODTVATX',
      'PRODTYPVTE',
      'PRODUNITVTE',
    ]);
  });

  it('ignores an EAN field holding the product code', () => {
    const { draft, issues } = transformProduct(
      row({ PRODNUM: '320001', PRODUNIV: '3', PRODRAY: '20', PRODEAN13: '320001' }),
    );
    expect(draft.ean).toBeNull();
    expect(issues).toEqual([]);
  });

  it('flags a code that does not match its shelf', () => {
    const { issues } = transformProduct(row({ PRODNUM: '211001' }));
    expect(issues[0]!.field).toBe('PRODNUM');
  });

  it('keeps distinct qualities from the repeated legacy lists', () => {
    expect(parseQualities(',0,1,0,1,0,1')).toEqual(['LOCAL', 'ORGANIC']);
    expect(parseQualities('3,3,3')).toEqual(['STANDARD']);
    expect(parseQualities(null)).toEqual([]);
  });
});

describe('payments (adhpayements)', () => {
  const p = (motif: string, amount: string, mod = 0) =>
    planPayment(
      {
        PAYID: 1,
        PAYADHID: 2,
        PAYDATE: '2026-05-01',
        PAYMNT: amount,
        PAYMOTIF: motif,
        PAYMOD: mod,
      },
      '2026-10-03',
    );

  it('maps the motives', () => {
    expect(p('01002', '12.00', 1).plan).toEqual({
      kind: 'payment',
      purpose: 'MEMBERSHIP',
      method: 'CHEQUE',
      amount: '12.00',
    });
    expect(p('01004', '5', 2).plan).toMatchObject({ purpose: 'DONATION', method: 'CARD' });
    expect(p('01010', '50', 3).plan).toEqual({
      kind: 'topup',
      method: 'TRANSFER',
      amount: '50.00',
    });
    expect(p('01011', '-12.30', 3).plan).toMatchObject({
      kind: 'wallet',
      walletKind: 'PURCHASE',
      amount: '-12.30',
    });
  });

  it('turns a negative top-up into a reported correction', () => {
    const r = p('01010', '-5', 0);
    expect(r.plan).toMatchObject({ kind: 'wallet', walletKind: 'CORRECTION', amount: '-5.00' });
    expect(r.issues).toHaveLength(1);
  });

  it('reports an unknown mode and a future date', () => {
    const r = planPayment(
      { PAYID: 1, PAYADHID: 2, PAYDATE: '2026-12-04', PAYMNT: '20', PAYMOTIF: '01010', PAYMOD: -1 },
      '2026-10-03',
    );
    expect(r.plan).toEqual({ kind: 'topup', method: null, amount: '20.00' });
    expect(r.issues.map((i) => i.field).sort()).toEqual(['PAYDATE', 'PAYMOD']);
  });
});

describe('tickets', () => {
  it('splits TICKMODPAY into non-zero payments', () => {
    expect(parseTicketPayments('38.78|0|0|0')).toEqual([{ method: 'CASH', cents: 3878 }]);
    expect(parseTicketPayments('0|0|13.8|-3.85')).toEqual([
      { method: 'CARD', cents: 1380 },
      { method: 'WALLET', cents: -385 },
    ]);
    expect(parseTicketPayments('abc')).toBeNull();
  });

  it('rounds legacy floats exactly', () => {
    expect(legacyCents(0.1 + 0.2)).toBe(30);
    expect(legacyCents(-2.675)).toBe(-268);
    expect(fixed(1.2345, 3)).toBe('1.235');
  });
});
