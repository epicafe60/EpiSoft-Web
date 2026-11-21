import { describe, expect, it } from 'vitest';
import { documentTitle, pageNameOfPath } from './page-title';

describe('document title (RGAA 8.5)', () => {
  it('gives each page its own title', () => {
    expect(documentTitle('/catalogue', 'EpiSoft')).toBe('Produits – EpiSoft');
    expect(documentTitle('/catalogue/prix', 'EpiSoft')).toBe('Grille de prix – EpiSoft');
    expect(documentTitle('/catalogue/0190b2c0-0000-7000-8000-000000000000', 'EpiSoft')).toBe(
      'Fiche produit – EpiSoft',
    );
    expect(documentTitle('/', 'EpiSoft')).toBe('Accueil – EpiSoft');
    expect(documentTitle('/admin/parametres/', 'Mon épicerie')).toBe('Paramètres – Mon épicerie');
  });
  it('falls back to the name of the software for an unknown address', () => {
    expect(pageNameOfPath('/nimportequoi')).toBeNull();
    expect(documentTitle('/nimportequoi', 'EpiSoft')).toBe('EpiSoft');
  });
});
