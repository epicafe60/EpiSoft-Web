import { describe, expect, it } from 'vitest';
import {
  autoMapColumns,
  normalizeMember,
  normalizeProduct,
  parseImportCsv,
  parseFrNumber,
  toRecords,
} from './imports';

describe('parseImportCsv (R-IMP-03)', () => {
  it('detects ; and handles quotes, BOM and CRLF', () => {
    const rows = parseImportCsv('﻿Nom;Prix\r\n"Miel; de fleurs";"3,50"\r\n"Dit ""ok""";1\r\n');
    expect(rows).toEqual([
      ['Nom', 'Prix'],
      ['Miel; de fleurs', '3,50'],
      ['Dit "ok"', '1'],
    ]);
  });
  it('detects a comma delimiter and skips blank lines', () => {
    expect(parseImportCsv('a,b\n\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseFrNumber', () => {
  it('reads French and plain numbers', () => {
    expect(parseFrNumber('1 234,56 €')).toBe(1234.56);
    expect(parseFrNumber('12.5')).toBe(12.5);
    expect(parseFrNumber('1.234,50')).toBe(1234.5);
    expect(parseFrNumber('abc')).toBeNull();
    expect(parseFrNumber('')).toBeNull();
  });
});

describe('column mapping', () => {
  it('maps headers by synonyms, accents ignored', () => {
    const m = autoMapColumns(['Prénom', 'Nom', 'Courriel', 'Solde'], 'members');
    expect(m).toEqual({ firstName: 0, lastName: 1, email: 2, balance: 3 });
  });
  it('builds records from a mapping', () => {
    expect(toRecords([['a', ' b ']], { x: 1, y: 0 })).toEqual([{ x: 'b', y: 'a' }]);
  });
});

describe('normalizeProduct (R-IMP-01)', () => {
  it('converts TTC purchase prices to HT and units to cents / thousandths', () => {
    const { value } = normalizeProduct({
      code: 'P1',
      name: 'Miel',
      purchasePrice: '5,50',
      priceType: 'TTC',
      vatRate: '5,5',
      salePrice: '7,9',
      stock: '12,5',
    });
    expect(value).toMatchObject({ purchaseExcl4: 52_133, salePriceCents: 790, stockMilli: 12_500 });
  });
  it('rejects a missing code or an invalid price', () => {
    expect(normalizeProduct({ name: 'x' }).error).toMatch(/Code/);
    expect(normalizeProduct({ code: 'a', name: 'x', salePrice: 'zz' }).error).toMatch(/invalide/);
  });
});

describe('normalizeMember (R-IMP-02)', () => {
  it('lowercases the email and parses the balance', () => {
    expect(
      normalizeMember({ firstName: 'Ann', lastName: 'Roy', email: 'A@B.fr', balance: '12,30' })
        .value,
    ).toMatchObject({ email: 'a@b.fr', balanceCents: 1230 });
  });
  it('rejects a bad email', () => {
    expect(normalizeMember({ firstName: 'A', lastName: 'B', email: 'nope' }).error).toBeDefined();
  });
  it('refuses what the member form refuses: a user name like an e-mail, too long values', () => {
    // The sign-in accepts a user name or an e-mail: one account's user name must never be
    // another account's address.
    const base = { firstName: 'A', lastName: 'B' };
    expect(normalizeMember({ ...base, username: 'admin@epicafe.fr' }).error).toMatch(/Identifiant/);
    expect(normalizeMember({ ...base, username: 'Ann_ROY' }).value?.username).toBe('Ann_ROY');
    expect(normalizeMember({ ...base, firstName: 'x'.repeat(101) }).error).toBeDefined();
    expect(normalizeMember({ ...base, phone: '0'.repeat(31) }).error).toBeDefined();
  });
});
