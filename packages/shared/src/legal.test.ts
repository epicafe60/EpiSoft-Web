import { describe, expect, it } from 'vitest';
import {
  buildLegalPages,
  CONSENT_PURPOSES,
  CONSENTS,
  currentConsents,
  DEFAULT_LEGAL_TEXTS,
  legalGaps,
  PROCESSING_REGISTER,
} from './legal';

const identity = {
  name: 'Épicafé de Montjavoult',
  street: '1 place de la Mairie',
  postcode: '60240',
  city: 'Montjavoult',
  siren: null,
  rna: 'W602000000',
  email: 'contact@epicafe.test',
  phone: null,
};

describe('legal pages', () => {
  it('lists what is compulsory and still missing', () => {
    expect(legalGaps(identity, DEFAULT_LEGAL_TEXTS)).toEqual([
      'le directeur ou la directrice de la publication',
      'le nom et l’adresse de l’hébergeur',
    ]);
    expect(
      legalGaps(identity, {
        ...DEFAULT_LEGAL_TEXTS,
        publicationDirector: 'A. B.',
        hostName: 'H',
        hostAddress: 'Paris',
      }),
    ).toEqual([]);
  });

  it('writes the standard wording from the identity, and the written text where there is one', () => {
    const p = buildLegalPages(identity, {
      ...DEFAULT_LEGAL_TEXTS,
      retention: 'Cinq ans.\nPuis effacement.',
    });
    expect(p.mentions[0]!.paragraphs.join(' ')).toMatch(/W602000000/);
    expect(p.privacy.find((s) => s.title.startsWith('Combien'))!.paragraphs).toEqual([
      'Cinq ans.',
      'Puis effacement.',
    ]);
    expect(p.privacy.map((s) => s.title)).toEqual(
      expect.arrayContaining(['Responsable du traitement', 'Base légale', 'Vos droits']),
    );
    expect(p.privacy.find((s) => s.title === 'Vos droits')!.paragraphs.join(' ')).toMatch(
      /contact@epicafe.test/,
    );
  });
});

describe('consents', () => {
  it('every purpose has a text, a version and a basis', () => {
    for (const k of CONSENT_PURPOSES) {
      expect(CONSENTS[k].text.length).toBeGreaterThan(20);
      expect(CONSENTS[k].version).toMatch(/^\d{4}-\d{2}/);
    }
  });
  it('the current choice is the latest record, a withdrawal included', () => {
    const rec = (granted: boolean, at: string) => ({
      id: at,
      purpose: 'NEWSLETTER',
      granted,
      textVersion: '2026-11',
      channel: 'STAFF_FORM',
      at,
      recordedBy: null,
    });
    const cur = currentConsents([
      rec(false, '2026-11-03T10:00:00Z'),
      rec(true, '2026-11-01T10:00:00Z'),
    ]);
    expect(cur.get('NEWSLETTER')!.granted).toBe(false);
  });
});

describe('register of processing', () => {
  it('says for each processing what data, why and for how long', () => {
    for (const a of PROCESSING_REGISTER) {
      expect(a.data.length).toBeGreaterThan(0);
      expect(a.purpose).not.toBe('');
      expect(a.basis).not.toBe('');
      expect(a.retention).not.toBe('');
      expect(a.tables.length).toBeGreaterThan(0);
    }
    expect(new Set(PROCESSING_REGISTER.map((a) => a.id)).size).toBe(PROCESSING_REGISTER.length);
  });
});
