import { describe, expect, it } from 'vitest';
import {
  legacyBool,
  mergeRoles,
  qrUsage,
  transformMember,
  type LegacyCommune,
  type LegacyMemberRow,
} from './transform';

const communes = new Map<number, LegacyCommune>([[1, { legacyId: 1, postcode: '60240' }]]);
const households = new Set([2, 5]);

const row = (over: Partial<LegacyMemberRow> = {}): LegacyMemberRow => ({
  MBREID: 7,
  MBRENOM: '  DUPONT ',
  MBREPRENOM: 'Marie',
  MBREADR: '1 rue  Haute',
  MBRECPOST: 60240,
  MBRECITY: 1,
  MBRETELEPH: '0600000000',
  MBREMAIL: 'marie@example.org',
  MBREREF: 2,
  MBRESTATUT: 1,
  MBREPERMS: '0|3',
  MBREVISIBLE: -1,
  MBRENEWS: 0,
  MBREUSERNAME: 'Marie_DUPONT',
  qr: 'ABCDEFGHIJKLMNOP',
  ...over,
});

const run = (r: LegacyMemberRow, all: LegacyMemberRow[] = [r]) =>
  transformMember(r, communes, qrUsage(all), households);

describe('transformMember (spec §6.3)', () => {
  it('maps a clean row without issues', () => {
    const { draft, issues } = run(row());
    expect(issues).toEqual([]);
    expect(draft).toMatchObject({
      legacyMbreid: 7,
      legacyHouseholdId: 2,
      lastName: 'DUPONT',
      street: '1 rue Haute',
      postcode: '60240',
      legacyCommuneId: 1,
      status: 'ACTIVE',
      publicVisible: true,
      newsletter: false,
      roles: ['CAISSE', 'ADHERENTS'],
      qrToken: 'ABCDEFGHIJKLMNOP',
    });
  });

  it('maps MBRESTATUT 0–3', () => {
    expect(run(row({ MBRESTATUT: 0 })).draft.status).toBe('NEW');
    expect(run(row({ MBRESTATUT: 3 })).draft.status).toBe('ARCHIVED');
  });

  it('drops a QR code shared by several members and reports it', () => {
    const a = row({ MBREID: 1 });
    const b = row({ MBREID: 2 });
    const { draft, issues } = run(a, [a, b]);
    expect(draft.qrToken).toBeNull();
    expect(issues.map((i) => i.problem)).toContain('QR code non unique');
  });

  it('keeps a short but unique QR code and reports it', () => {
    const { draft, issues } = run(row({ qr: 'SHORT123' }));
    expect(draft.qrToken).toBe('SHORT123');
    expect(issues).toHaveLength(1);
  });

  it('prefers the commune postcode when they disagree', () => {
    const { draft, issues } = run(row({ MBRECPOST: 602240 }));
    expect(draft.postcode).toBe('60240');
    expect(issues[0]?.field).toBe('MBRECPOST');
  });

  it('reports unknown permissions, invalid e-mails and missing households', () => {
    const { draft, issues } = run(row({ MBREPERMS: '-1', MBREMAIL: 'nope', MBREREF: 99 }));
    expect(draft.roles).toEqual([]);
    expect(draft.email).toBeNull();
    expect(draft.legacyHouseholdId).toBeNull();
    expect(issues.map((i) => i.field).sort()).toEqual(['MBREMAIL', 'MBREPERMS', 'MBREREF']);
  });

  it('treats empty QR codes as absent', () => {
    expect(run(row({ qr: '' })).draft.qrToken).toBeNull();
    expect(run(row({ qr: null })).draft.qrToken).toBeNull();
  });
});

describe('legacyBool', () => {
  it('reads Pascal booleans', () => {
    expect(legacyBool(-1)).toBe(true);
    expect(legacyBool(1)).toBe(true);
    expect(legacyBool(0)).toBe(false);
    expect(legacyBool(null)).toBe(false);
  });
});

describe('mergeRoles (repeated migrations)', () => {
  it('follows legacy roles and keeps v2-only roles', () => {
    expect(mergeRoles(['CAISSE', 'COMPTA', 'ADMIN'], ['CAISSE', 'ADHERENTS'])).toEqual([
      'CAISSE',
      'ADHERENTS',
      'ADMIN',
    ]);
  });
});
