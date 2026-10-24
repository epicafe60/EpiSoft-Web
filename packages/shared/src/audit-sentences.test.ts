import { describe, expect, it } from 'vitest';
import { AUDIT_SENTENCES, describeAudit } from './audit-sentences';

describe('describeAudit', () => {
  it('says what happened in plain French', () => {
    expect(describeAudit('product.create', { name: 'Lentilles' })).toBe(
      'a créé un produit « Lentilles »',
    );
    expect(describeAudit('wallet.topup', { amount: '20.00' })).toContain('20.00 €');
    expect(describeAudit('session.close')).toBe('a clôturé une session de caisse');
  });

  it('copes with a missing or odd payload', () => {
    expect(describeAudit('product.create', null)).toBe('a créé un produit');
    expect(describeAudit('product.create', 'texte')).toBe('a créé un produit');
    expect(describeAudit('wallet.correction', {})).toBe('a corrigé une cagnotte');
  });

  it('has a readable fallback for an action it does not know', () => {
    expect(describeAudit('truc.nouveau_machin')).toBe(
      'a effectué l’action « truc nouveau machin »',
    );
  });

  it('never shows a technical code or an English word to the user', () => {
    for (const [action, f] of Object.entries(AUDIT_SENTENCES)) {
      const text = f({ name: 'X', number: 'N', label: 'L', key: 'k' });
      expect(text, action).not.toMatch(/R-[A-Z]{3}-\d/);
      expect(text, action).not.toMatch(/\b(create|update|delete|undefined|null)\b/i);
    }
  });
});
