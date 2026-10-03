import { describe, expect, it } from 'vitest';
import { centsToDecimal, formatEuro, parseAmountToCents } from './money';
import { settingSchemas } from './settings';
import { normalizeSearch } from './text';

describe('parseAmountToCents (§5.1)', () => {
  it('accepts a comma or a dot', () => {
    expect(parseAmountToCents('12,5')).toBe(1250);
    expect(parseAmountToCents('12.50')).toBe(1250);
    expect(parseAmountToCents('12')).toBe(1200);
  });

  it('ignores thousand separators and the euro sign', () => {
    expect(parseAmountToCents('1 234,56 €')).toBe(123456);
    expect(parseAmountToCents('1\u202f234,56')).toBe(123456);
  });

  it('rounds half up to the cent', () => {
    expect(parseAmountToCents('0,005')).toBe(1);
    expect(parseAmountToCents('0,004')).toBe(0);
    expect(parseAmountToCents('-1,255')).toBe(-126);
  });

  it('rejects non-numbers', () => {
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('1,2,3')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
  });
});

describe('centsToDecimal / formatEuro', () => {
  it('formats decimal strings', () => {
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-1250)).toBe('-12.50');
  });

  it('formats in French', () => {
    expect(formatEuro('1234.5').replace(/[\u202f\u00a0]/g, ' ')).toBe('1 234,50 €');
  });
});

describe('settings schemas (R-ADM-01)', () => {
  it('normalizes the default float', () => {
    expect(settingSchemas['pos.defaultFloat'].parse({ amount: '150,5' })).toEqual({
      amount: '150.50',
    });
  });

  it('rejects a negative overdraft', () => {
    expect(settingSchemas['wallet.overdraftLimit'].safeParse({ amount: '-5' }).success).toBe(false);
  });

  it('validates SIREN', () => {
    const base = settingSchemas['association.identity'].parse({
      name: 'X',
      street: '',
      postcode: '',
      city: '',
      siren: '',
      rna: '',
      email: '',
      phone: '',
    });
    expect(base.siren).toBeNull();
    expect(
      settingSchemas['association.identity'].safeParse({ ...base, siren: '12345' }).success,
    ).toBe(false);
  });
});

describe('R-MBR-06 normalizeSearch', () => {
  it('is accent and case insensitive', () => {
    expect(normalizeSearch('  Éloïse  DUPRÉ ')).toBe('eloise dupre');
  });
});
