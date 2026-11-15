import { describe, expect, it } from 'vitest';
import {
  brandingLogoUrl,
  brandingSchema,
  contrastWithWhite,
  DEFAULT_BRANDING,
  DEFAULT_LOGO_URL,
} from './branding';
import { EMAIL_TEMPLATES, appValues, fillText, sampleValues } from './email-templates';
import { SETTING_DEFAULTS, settingSchemas } from './settings';

describe('branding of the application', () => {
  it('ships the Épicafé values, and they are valid', () => {
    expect(SETTING_DEFAULTS['app.branding']).toEqual(DEFAULT_BRANDING);
    expect(settingSchemas['app.branding'].safeParse(DEFAULT_BRANDING).success).toBe(true);
  });

  it('measures the contrast against white', () => {
    expect(contrastWithWhite('#000000')).toBeCloseTo(21, 0);
    expect(contrastWithWhite('#ffffff')).toBeCloseTo(1, 1);
    expect(contrastWithWhite(DEFAULT_BRANDING.accentColor)).toBeGreaterThan(4.5);
  });

  it('refuses a colour white text cannot be read on, an empty name or a bad colour', () => {
    const base = { ...DEFAULT_BRANDING, appName: 'Mon épicerie', shortName: 'Mon épicerie' };
    expect(brandingSchema.safeParse({ ...base, accentColor: '#1d4ed8' }).success).toBe(true);
    expect(brandingSchema.safeParse({ ...base, accentColor: '#ffee00' }).success).toBe(false);
    expect(brandingSchema.safeParse({ ...base, accentColor: 'green' }).success).toBe(false);
    expect(brandingSchema.safeParse({ ...base, appName: '  ' }).success).toBe(false);
    expect(brandingSchema.safeParse({ ...base, logoImageId: 'not-a-uuid' }).success).toBe(false);
  });

  it('points at the shipped logo, or at the chosen one', () => {
    expect(brandingLogoUrl(null)).toBe(DEFAULT_LOGO_URL);
    const id = '0197a0de-0000-7000-8000-00000e91c0f0';
    expect(brandingLogoUrl(id)).toBe(`/api/v1/branding/logo/${id}`);
  });
});

describe('the names in the e-mails', () => {
  it('every template knows the names of the association, and none is tied to the Épicafé', () => {
    for (const t of EMAIL_TEMPLATES) {
      const names = t.variables.map((v) => v.name);
      expect(names).toEqual(
        expect.arrayContaining(['association', 'association_court', 'application']),
      );
      expect(t.subject + t.body).not.toMatch(/Épicafé|EpiSoft/);
    }
  });

  it('keeps the wording of the Épicafé by default, and follows the settings', () => {
    const t = EMAIL_TEMPLATES.find((x) => x.key === 'sale_receipt')!;
    const values = { ...sampleValues(t), numero: '12' };
    expect(fillText(t.subject, values, t.variables)).toBe('Épicafé : ticket 12');
    const other = {
      ...values,
      ...appValues({ shortName: 'Le Panier', appName: 'GestEpicerie' }, 'Le Panier de Rouen'),
    };
    expect(fillText(t.subject, other, t.variables)).toBe('Le Panier : ticket 12');
  });
});
