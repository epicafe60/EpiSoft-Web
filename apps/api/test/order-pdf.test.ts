import { describe, expect, it } from 'vitest';
import { drawOrderSheet, type OrderSheet } from '../src/lib/order-sheet';
import { render } from '../src/lib/pdf';

// The purchase order sent to a supplier (R-CMD-03): the layout of the paper order, on one or more pages.

const identity = {
  name: 'Épicafé de Montjavoult',
  street: '9 bis rue de la Mairie',
  postcode: '60240',
  city: 'Montjavoult',
  siren: '943245233',
  rna: 'W601009087',
  email: 'epicafe60@gmail.com',
  phone: '0743446391',
};

const sheet = (rows: OrderSheet['rows'], extra: Partial<OrderSheet> = {}): OrderSheet => ({
  identity,
  number: 'CF-2026-0001',
  date: '06/07/2026',
  supplier: { name: "M'PARNATURE", lines: ['30 Rue Parmentier', '60590 Sérifontaine'] },
  rows,
  total: '172,00',
  comment: null,
  ...extra,
});

const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('the purchase order PDF', () => {
  it('is a PDF of one page for a short order, with the logo inside', async () => {
    const pdf = await render((d) =>
      drawOrderSheet(
        d,
        sheet([
          ["Savon l'exfoliant 100g", '5,60', '5', '28,00'],
          ['Fée le ménage', '6,00', '2', '12,00'],
        ]),
      ),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBe(1);
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
  });

  it('goes on on a second page for a long order, with the comment and the total', async () => {
    const rows = Array.from({ length: 60 }, (_, i): OrderSheet['rows'][number] => [
      `Produit ${i + 1} à la désignation assez longue pour passer à la ligne dans la colonne`,
      '1,00',
      '1',
      '1,00',
    ]);
    const pdf = await render((d) =>
      drawOrderSheet(d, sheet(rows, { comment: 'Livraison mardi.' })),
    );
    expect(pages(pdf)).toBeGreaterThan(1);
  });

  it('is made when the supplier or the identifiers are not known', async () => {
    const pdf = await render((d) =>
      drawOrderSheet(d, {
        ...sheet([['Un produit', '1,00', '1', '1,00']]),
        supplier: null,
        identity: {
          ...identity,
          street: '',
          postcode: '',
          siren: '',
          rna: '',
          email: '',
          phone: '',
        },
      } as unknown as OrderSheet),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
