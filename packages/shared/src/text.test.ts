import { describe, expect, it } from 'vitest';
import { cleanText, isValidEmail, normalizeSearch } from './text';
import { sha256Hex } from './crypto';

describe('normalizeSearch (R-MBR-06)', () => {
  it('removes accents, case and extra spaces', () => {
    expect(normalizeSearch('  Éloïse   DE  la Côte ')).toBe('eloise de la cote');
  });
  it('is idempotent', () => {
    const once = normalizeSearch('Crème Brûlée');
    expect(normalizeSearch(once)).toBe(once);
  });
  it('handles empty input', () => {
    expect(normalizeSearch('   ')).toBe('');
  });
});

describe('cleanText', () => {
  it('collapses whitespace', () => {
    expect(cleanText('  a   b\n c ')).toBe('a b c');
  });
  it('returns null for null, undefined and blank', () => {
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
    expect(cleanText(' \t ')).toBeNull();
  });
});

describe('isValidEmail', () => {
  it.each(['a@b.fr', 'prenom.nom+tag@exemple.org'])('accepts %s', (e) => {
    expect(isValidEmail(e)).toBe(true);
  });
  it.each(['', 'a@b', 'a b@c.fr', '@b.fr', 'a@.fr ', 'a@@b.fr'])('rejects "%s"', (e) => {
    expect(isValidEmail(e)).toBe(false);
  });
});

describe('sha256Hex (R-SYNC-06)', () => {
  it('matches known vectors', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('encodes UTF-8', async () => {
    expect((await sha256Hex('é')).length).toBe(64);
    expect(await sha256Hex('é')).not.toBe(await sha256Hex('e'));
  });
});
