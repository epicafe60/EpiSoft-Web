import { describe, expect, it } from 'vitest';
import {
  hasAnyRole,
  identityChangeAllowed,
  isStaffAccount,
  parseLegacyPerms,
  visibleModules,
} from './roles';

describe('parseLegacyPerms (annex B)', () => {
  it('maps legacy indices to roles', () => {
    expect(parseLegacyPerms('0|1|3')).toEqual({
      roles: ['CAISSE', 'COMMANDES_EN_LIGNE', 'ADHERENTS'],
      unknown: [],
    });
  });

  it('maps index 5 to APPROS and 6 to COMPTA', () => {
    expect(parseLegacyPerms('6|5').roles).toEqual(['APPROS', 'COMPTA']);
  });

  it('handles empty, null and spaced values', () => {
    expect(parseLegacyPerms(null).roles).toEqual([]);
    expect(parseLegacyPerms('').roles).toEqual([]);
    expect(parseLegacyPerms(' 0 | 3 |').roles).toEqual(['CAISSE', 'ADHERENTS']);
  });

  it('removes duplicates and reports unknown tokens', () => {
    expect(parseLegacyPerms('0|0|9|x')).toEqual({ roles: ['CAISSE'], unknown: ['9', 'x'] });
  });
});

describe('module access (R-AUTH-05, R-AUTH-06)', () => {
  it('a member without COMPTA does not see the accounting module', () => {
    const keys = visibleModules(['CAISSE', 'ADHERENTS']).map((m) => m.key);
    expect(keys).toEqual(['caisse', 'membres']);
    expect(keys).not.toContain('compta');
  });

  it('pre-orders open with either pre-order role', () => {
    expect(visibleModules(['COMMANDES_GESTION']).map((m) => m.key)).toEqual(['precommandes']);
  });

  it('an empty requirement is satisfied by anyone', () => {
    expect(hasAnyRole([], [])).toBe(true);
    expect(hasAnyRole([], ['ADMIN'])).toBe(false);
  });

  it('ADMIN has every module, others only theirs', () => {
    expect(hasAnyRole(['ADMIN'], ['COMPTA'])).toBe(true);
    expect(hasAnyRole(['CAISSE'], ['COMPTA'])).toBe(false);
    expect(visibleModules(['ADMIN']).map((m) => m.key)).toContain('compta');
  });
});

describe('identityChangeAllowed (audit KV2, S02)', () => {
  it('lets only an administrator change the e-mail or user name of a staff account', () => {
    expect(identityChangeAllowed(['ADHERENTS'], ['ADMIN'])).toBe(false);
    expect(identityChangeAllowed(['ADHERENTS'], ['CAISSE'])).toBe(false);
    expect(identityChangeAllowed(['ADHERENTS'], ['ADHERENTS'])).toBe(false);
    expect(identityChangeAllowed(['ADMIN'], ['ADMIN'])).toBe(true);
    expect(identityChangeAllowed(['ADMIN', 'ADHERENTS'], ['COMPTA'])).toBe(true);
  });

  it('leaves ordinary members and online-shop customers editable by the members team', () => {
    expect(identityChangeAllowed(['ADHERENTS'], [])).toBe(true);
    expect(identityChangeAllowed(['ADHERENTS'], ['COMMANDES_EN_LIGNE'])).toBe(true);
  });

  it('tells a staff account from a shop customer', () => {
    expect(isStaffAccount([])).toBe(false);
    expect(isStaffAccount(['COMMANDES_EN_LIGNE'])).toBe(false);
    expect(isStaffAccount(['COMMANDES_EN_LIGNE', 'CAISSE'])).toBe(true);
  });
});
