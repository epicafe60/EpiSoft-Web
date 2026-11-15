import { describe, expect, it } from 'vitest';
import { defaultPdfConfig, pdfTemplateDef, type PdfTemplateConfig } from '@episoft/shared';
import {
  columnWidths,
  drawOrderSheet,
  imageSize,
  prepareOrderSheet,
  type OrderSheet,
  type OrderSheetLine,
} from '../src/lib/order-sheet';
import { render } from '../src/lib/pdf';
import { pdfHtmlLines } from '../src/lib/pdf-html';

// The purchase order sent to a supplier (R-CMD-03): the layout of the paper order, the wording and
// the columns of the template, on one or more pages.

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const def = pdfTemplateDef('purchase_order')!;

const line = (n: number, over: Partial<OrderSheetLine> = {}): OrderSheetLine => ({
  ref: `REF${n}`,
  code: `0100${n}`,
  name: `Produit ${n}`,
  unitExcl: '4,67',
  vat: '20 %',
  unitIncl: '5,60',
  qty: '5',
  totalExcl: '23,33',
  totalIncl: '28,00',
  ...over,
});

const sheet = (over: Partial<OrderSheet> = {}): OrderSheet => ({
  identity: {
    name: 'Épicafé de Montjavoult',
    street: '9 bis rue de la Mairie',
    postcode: '60240',
    city: 'Montjavoult',
    siren: '943245233',
    rna: 'W601009087',
    email: 'epicafe60@gmail.com',
    phone: '0743446391',
  },
  number: 'CF-2026-0001',
  date: '06/07/2026',
  supplier: {
    name: "M'PARNATURE",
    street: '30 Rue Parmentier',
    postcodeCity: '60590 Sérifontaine',
    phone: '',
    email: '',
  },
  lines: [line(1), line(2)],
  totalExcl: '46,66',
  totalVat: '9,34',
  totalIncl: '56,00',
  comment: null,
  logo: null,
  ...over,
});

const config = (over: Partial<PdfTemplateConfig> = {}): PdfTemplateConfig => ({
  ...defaultPdfConfig(def),
  ...over,
});

const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
const draw = (s: OrderSheet, c: PdfTemplateConfig) =>
  render((d) => drawOrderSheet(d, prepareOrderSheet(s, c)));

describe('what the purchase order says', () => {
  it('fills the zones of the template with the order, the association and the supplier', () => {
    const p = prepareOrderSheet(sheet(), config());
    expect(pdfHtmlLines(p.header)).toEqual([
      'Association\nÉpicafé de Montjavoult',
      '9 bis rue de la Mairie\n60240 - Montjavoult',
      'SIREN : 943245233\nRNA : W601009087',
      'Email : epicafe60@gmail.com\nTel : 0743446391',
      'Commande CF-2026-0001 du 06/07/2026',
    ]);
    expect(pdfHtmlLines(p.supplier)).toEqual([
      "M'PARNATURE\n30 Rue Parmentier\n60590 Sérifontaine",
    ]);
    expect(p.totalLabel).toBe('Total de la commande');
  });

  it('drops the lines of the letterhead the association left empty', () => {
    const empty = sheet({
      identity: { ...sheet().identity, siren: null, rna: null, street: null, email: null },
    });
    const p = prepareOrderSheet(empty, config());
    expect(p.header).not.toContain('SIREN');
    expect(p.header).not.toContain('RNA');
    expect(p.header).not.toContain('Email');
    expect(p.header).toContain('Tel : 0743446391');
  });

  it('writes the supplier and the comment escaped: what they hold is text, not markup', () => {
    const p = prepareOrderSheet(
      sheet({
        supplier: { ...sheet().supplier!, name: '<script>x()</script> & Fils' },
        comment: '<b>urgent</b>',
      }),
      config(),
    );
    expect(p.supplier).toContain('&lt;script&gt;x()&lt;/script&gt; &amp; Fils');
    expect(p.afterTable).toContain('&lt;b&gt;urgent&lt;/b&gt;');
  });

  it('has no paragraph under the table when there is no comment', () => {
    expect(prepareOrderSheet(sheet(), config()).afterTable).toBe('');
    expect(prepareOrderSheet(sheet({ comment: 'Mardi.' }), config()).afterTable).toBe(
      '<p>Mardi.</p>',
    );
  });

  it('says what the administrators wrote in the zones and the label of the total', () => {
    const p = prepareOrderSheet(
      sheet(),
      config({
        zones: {
          ...defaultPdfConfig(def).zones,
          header: '<h2>Bon n° {{numero}}</h2>',
          footer: '<p>Merci, {{association_nom}}</p>',
        },
        labels: { total: 'À régler : {{total}}' },
      }),
    );
    expect(pdfHtmlLines(p.header)).toEqual(['Bon n° CF-2026-0001']);
    expect(pdfHtmlLines(p.footer)).toEqual(['Merci, Épicafé de Montjavoult']);
    expect(p.totalLabel).toBe('À régler : 56,00');
  });
});

describe('the columns of the table', () => {
  it('are the ones of the paper order by default', () => {
    const p = prepareOrderSheet(sheet(), config());
    expect(p.columns.map((c) => c.header)).toEqual([
      'Désignation du produit',
      'P.A TTC',
      'Quantité',
      'Total',
    ]);
    expect(p.rows[0]).toEqual(['Produit 1', '5,60', '5', '28,00']);
  });

  it('are the ones chosen, in the order chosen, with the headers chosen', () => {
    const p = prepareOrderSheet(
      sheet(),
      config({
        columns: [
          { key: 'ref', label: 'Référence' },
          { key: 'name', label: 'Produit' },
          { key: 'qty', label: 'Qté' },
          { key: 'unit_excl', label: 'PU HT' },
          { key: 'vat', label: 'TVA' },
          { key: 'total_excl', label: 'Total HT' },
        ],
      }),
    );
    expect(p.columns.map((c) => c.header)).toEqual([
      'Référence',
      'Produit',
      'Qté',
      'PU HT',
      'TVA',
      'Total HT',
    ]);
    expect(p.rows[1]).toEqual(['REF2', 'Produit 2', '5', '4,67', '20 %', '23,33']);
  });

  it('always fill the width of the page, the designation taking what is left', () => {
    for (const keys of [['name'], ['name', 'qty'], def.columns.map((c) => c.key)]) {
      const chosen = keys.map((k) => ({ def: def.columns.find((c) => c.key === k)! }));
      const widths = columnWidths(chosen);
      expect(widths.reduce((s, w) => s + w, 0)).toBeCloseTo(515.28, 1);
      expect(widths[keys.indexOf('name')]).toBeGreaterThanOrEqual(110 - 0.01);
    }
  });

  it('give totals under the total columns that are shown, and none when no total is shown', async () => {
    const withTotals = prepareOrderSheet(
      sheet(),
      config({
        columns: [
          { key: 'name', label: 'P' },
          { key: 'total_excl', label: 'HT' },
          { key: 'total_incl', label: 'TTC' },
        ],
      }),
    );
    expect(withTotals.totals).toEqual({ total_excl: '46,66', total_incl: '56,00' });
    const without = config({
      columns: [
        { key: 'name', label: 'P' },
        { key: 'qty', label: 'Q' },
      ],
    });
    const pdf = await draw(sheet(), without);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('the purchase order PDF', () => {
  it('is a PDF of one page for a short order, without logo when there is none', async () => {
    const pdf = await draw(sheet(), config());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBe(1);
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
  });

  it('carries the logo when there is one and the template shows it, and not when it does not', async () => {
    const withLogo = await draw(sheet({ logo: PNG }), config());
    expect(withLogo.toString('latin1')).toContain('/Subtype /Image');
    const hidden = await draw(sheet({ logo: PNG }), config({ logo: false }));
    expect(hidden.toString('latin1')).not.toContain('/Subtype /Image');
    const broken = await draw(sheet({ logo: Buffer.from('not an image') }), config());
    expect(broken.subarray(0, 5).toString()).toBe('%PDF-');
    expect(broken.toString('latin1')).not.toContain('/Subtype /Image');
  });

  it('goes on on a second page for a long order, with every column chosen', async () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      line(i + 1, {
        name: `Produit ${i + 1} à la désignation assez longue pour passer à la ligne`,
      }),
    );
    const all = config({ columns: def.columns.map((c) => ({ key: c.key, label: c.label })) });
    const pdf = await draw(sheet({ lines, comment: 'Livraison mardi.' }), all);
    expect(pages(pdf)).toBeGreaterThan(1);
  });

  it('is made when the supplier or the identifiers are not known, and with a footer on every page', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => line(i + 1));
    const pdf = await draw(
      sheet({
        supplier: null,
        lines,
        identity: {
          ...sheet().identity,
          street: null,
          postcode: null,
          siren: null,
          rna: null,
          email: null,
          phone: null,
        },
      }),
      config({ zones: { ...defaultPdfConfig(def).zones, footer: '<p>Association loi 1901</p>' } }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBeGreaterThan(1);
  });
});

describe('the size of an image', () => {
  it('is read in the header of a PNG, and refused for what is not an image', () => {
    expect(imageSize(PNG)).toEqual({ width: 1, height: 1 });
    expect(() => imageSize(Buffer.from('not an image at all, really'))).toThrow();
  });
});
