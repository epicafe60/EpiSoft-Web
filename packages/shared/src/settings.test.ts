import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS, SETTING_KEYS, isSettingKey, settingSchemas } from './settings';

describe('settings', () => {
  it('every default value is accepted by its own schema', () => {
    for (const key of SETTING_KEYS) {
      const r = settingSchemas[key].safeParse(SETTING_DEFAULTS[key]);
      expect(r.success, `${key}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });
  it('has a default for every key and no extra', () => {
    expect(Object.keys(SETTING_DEFAULTS).sort()).toEqual([...SETTING_KEYS].sort());
  });
  it('isSettingKey ignores inherited properties', () => {
    expect(isSettingKey('pos.defaultFloat')).toBe(true);
    expect(isSettingKey('toString')).toBe(false);
    expect(isSettingKey('__proto__')).toBe(false);
  });

  it('accounting accounts need 6 digits', () => {
    const ok = settingSchemas['accounting.accounts'];
    expect(ok.safeParse({ ...SETTING_DEFAULTS['accounting.accounts'], sales: '707000' }).success).toBe(true);
    for (const bad of ['70700', '7070000', 'abcdef', '']) {
      expect(ok.safeParse({ ...SETTING_DEFAULTS['accounting.accounts'], sales: bad }).success).toBe(false);
    }
  });

  it('normalises amounts and refuses a negative overdraft (Q4)', () => {
    expect(settingSchemas['pos.defaultFloat'].parse({ amount: '50,5' })).toEqual({ amount: '50.50' });
    expect(settingSchemas['wallet.overdraftLimit'].safeParse({ amount: '-1' }).success).toBe(false);
    expect(settingSchemas['wallet.overdraftLimit'].parse({ amount: '20' })).toEqual({ amount: '20.00' });
    expect(settingSchemas['pos.defaultFloat'].safeParse({ amount: 'abc' }).success).toBe(false);
  });

  it('validates SIREN and RNA', () => {
    const s = settingSchemas['association.identity'];
    const base = SETTING_DEFAULTS['association.identity'];
    expect(s.safeParse({ ...base, siren: '123456789', rna: 'W123456789' }).success).toBe(true);
    expect(s.safeParse({ ...base, siren: '12345' }).success).toBe(false);
    expect(s.safeParse({ ...base, rna: '123456789' }).success).toBe(false);
    expect(s.parse({ ...base, siren: '  ' }).siren).toBeNull();
    expect(s.safeParse({ ...base, name: ' ' }).success).toBe(false);
  });

  it('validates the treasurer e-mail', () => {
    const s = settingSchemas['pos.treasurerEmail'];
    expect(s.parse({ email: '' }).email).toBeNull();
    expect(s.parse({ email: 'a@b.fr' }).email).toBe('a@b.fr');
    expect(s.safeParse({ email: 'oops' }).success).toBe(false);
  });

  it('bounds the numeric settings', () => {
    expect(settingSchemas['membership.reminder'].safeParse({ enabled: true, daysBefore: 0 }).success).toBe(false);
    expect(settingSchemas['membership.reminder'].safeParse({ enabled: true, daysBefore: 61 }).success).toBe(false);
    expect(settingSchemas['catalog.pricing'].safeParse({ targetMarkupPct: 96, rounding: 5 }).success).toBe(false);
    expect(settingSchemas['catalog.pricing'].safeParse({ targetMarkupPct: 25, rounding: 2 }).success).toBe(false);
    expect(settingSchemas['labels.layout'].safeParse({ perPage: 30 }).success).toBe(false);
  });
});
