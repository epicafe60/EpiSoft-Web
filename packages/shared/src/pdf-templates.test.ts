import { describe, expect, it } from 'vitest';
import { usedVariables } from './email-templates';
import {
  PDF_TEMPLATES,
  defaultPdfConfig,
  dropEmptyLines,
  effectivePdfConfig,
  fillLabel,
  fillZone,
  pdfSampleValues,
  pdfTemplateDef,
  pdfTemplateProblems,
  pdfTemplateSaveSchema,
  type PdfTemplateConfig,
  type PdfTemplateDef,
} from './pdf-templates';

// PDF templates: the wording and the columns of the documents the application makes (R-CMD-03).

const order = pdfTemplateDef('purchase_order')!;

describe('the documents the application ships with', () => {
  it.each(PDF_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s: unique keys, only known variables, a default that is valid',
    (_key, def) => {
      expect(new Set(def.zones.map((z) => z.key)).size).toBe(def.zones.length);
      expect(new Set(def.columns.map((c) => c.key)).size).toBe(def.columns.length);
      const known = new Set(def.variables.map((v) => v.name));
      for (const z of def.zones)
        for (const n of usedVariables(z.default))
          expect(known.has(n), `${def.key}: {{${n}}}`).toBe(true);
      const config = defaultPdfConfig(def);
      expect(pdfTemplateProblems(def, config)).toEqual([]);
      expect(pdfTemplateSaveSchema.safeParse(config).success).toBe(true);
    },
  );

  it('the purchase order shows by default the columns of the paper order, in its order', () => {
    expect(defaultPdfConfig(order).columns.map((c) => [c.key, c.label])).toEqual([
      ['name', 'Désignation du produit'],
      ['unit_incl', 'P.A TTC'],
      ['qty', 'Quantité'],
      ['total_incl', 'Total'],
    ]);
  });

  it('keeps a document without choice of columns free of them', () => {
    const closing = pdfTemplateDef('cash_closing')!;
    expect(defaultPdfConfig(closing).columns).toEqual([]);
    expect(
      pdfTemplateProblems(closing, {
        ...defaultPdfConfig(closing),
        columns: [{ key: 'name', label: 'P' }],
      }),
    ).toContain('Ce document n’a pas de colonnes à choisir.');
  });

  it('every document carries the logo of the association by default', () => {
    for (const def of PDF_TEMPLATES) {
      expect(def.logo, def.key).toBe(true);
      expect(defaultPdfConfig(def).logo, def.key).toBe(true);
    }
  });
});

describe('what an administrator may save', () => {
  const config = (over: Partial<PdfTemplateConfig>): PdfTemplateConfig => ({
    ...defaultPdfConfig(order),
    ...over,
  });

  it('accepts other columns, in another order, with other headers', () => {
    const c = config({
      columns: [
        { key: 'ref', label: 'Référence' },
        { key: 'name', label: 'Produit' },
        { key: 'qty', label: 'Qté' },
        { key: 'unit_excl', label: 'PU HT' },
        { key: 'total_excl', label: 'Total HT' },
      ],
    });
    expect(pdfTemplateProblems(order, c)).toEqual([]);
  });

  it('refuses a table without its product, without any column, with an unknown or a doubled one', () => {
    expect(pdfTemplateProblems(order, config({ columns: [{ key: 'qty', label: 'Qté' }] }))).toEqual(
      [expect.stringContaining('est indispensable')],
    );
    expect(pdfTemplateProblems(order, config({ columns: [] }))).toEqual(
      expect.arrayContaining(['Choisissez au moins une colonne.']),
    );
    const bad = config({
      columns: [
        { key: 'name', label: 'A' },
        { key: 'nimporte', label: 'B' },
        { key: 'name', label: 'C' },
      ],
    });
    expect(pdfTemplateProblems(order, bad)).toEqual(
      expect.arrayContaining([
        'Colonne inconnue : nimporte.',
        expect.stringContaining('en double'),
      ]),
    );
  });

  it('names the unknown variables of a zone, and a zone or a label that do not exist', () => {
    const c = config({
      zones: { header: '<p>{{numero}} {{nimporte}}</p>', ailleurs: '<p>x</p>' },
      labels: { autre: 'x' },
    });
    expect(pdfTemplateProblems(order, c)).toEqual(
      expect.arrayContaining([
        'Zone inconnue : ailleurs.',
        'Libellé inconnu : autre.',
        expect.stringContaining('{{nimporte}}'),
      ]),
    );
  });

  it('refuses an empty header of column, and a zone or a label that is too long', () => {
    expect(
      pdfTemplateSaveSchema.safeParse(config({ columns: [{ key: 'name', label: ' ' }] })).success,
    ).toBe(false);
    expect(
      pdfTemplateSaveSchema.safeParse(config({ zones: { header: 'x'.repeat(7000) } })).success,
    ).toBe(false);
    expect(
      pdfTemplateSaveSchema.safeParse(config({ labels: { total: 'x'.repeat(100) } })).success,
    ).toBe(false);
  });
});

describe('a saved template, completed by the default', () => {
  it('is the default when nothing was saved', () => {
    expect(effectivePdfConfig(order, null)).toEqual(defaultPdfConfig(order));
  });

  it('takes what was saved and the default for the rest (a zone added since)', () => {
    const e = effectivePdfConfig(order, { zones: { header: '<p>Mon en-tête</p>' } });
    expect(e.zones.header).toBe('<p>Mon en-tête</p>');
    expect(e.zones.supplier).toBe(order.zones.find((z) => z.key === 'supplier')!.default);
    expect(e.columns).toEqual(defaultPdfConfig(order).columns);
  });

  it('drops a column that no longer exists, and brings back one that cannot be taken off', () => {
    const e = effectivePdfConfig(order, {
      columns: [
        { key: 'disparue', label: 'X' },
        { key: 'qty', label: 'Qté' },
      ],
    });
    expect(e.columns.map((c) => c.key)).toEqual(['name', 'qty']);
  });

  it('never gives a logo to a document that has none, and refuses to save one', () => {
    const noLogo = { ...pdfTemplateDef('cash_closing')!, logo: false } as PdfTemplateDef;
    expect(effectivePdfConfig(noLogo, { logo: true }).logo).toBe(false);
    expect(pdfTemplateProblems(noLogo, { ...defaultPdfConfig(noLogo), logo: true })).toEqual([
      'Ce document n’a pas de logo.',
    ]);
  });
});

describe('filling the zones', () => {
  it('drops a line whose variables are all empty, and keeps the others', () => {
    const html = '<p>SIREN : {{siren}}<br>RNA : {{rna}}<br>Association</p><p>Tel : {{tel}}</p>';
    expect(dropEmptyLines(html, { siren: '', rna: 'W601009087', tel: '  ' })).toBe(
      '<p>RNA : {{rna}}<br>Association</p>',
    );
  });

  it('keeps a line with several variables as long as one has a value', () => {
    expect(dropEmptyLines('<p>{{a}} - {{b}}</p>', { a: '', b: 'x' })).toBe('<p>{{a}} - {{b}}</p>');
    expect(dropEmptyLines('<p>{{a}} - {{b}}</p>', { a: '', b: '' })).toBe('');
  });

  it('writes the values escaped: a supplier cannot add markup to the document', () => {
    const v = pdfSampleValues(order);
    const html = fillZone(
      '<p>{{fournisseur_nom}}</p>',
      { ...v, fournisseur_nom: '<b>x</b> & Cie' },
      order.variables,
    );
    expect(html).toBe('<p>&lt;b&gt;x&lt;/b&gt; &amp; Cie</p>');
  });

  it('leaves no variable behind with the samples, in any zone of any document', () => {
    for (const def of PDF_TEMPLATES)
      for (const z of def.zones)
        expect(
          fillZone(z.default, pdfSampleValues(def), def.variables),
          `${def.key}/${z.key}`,
        ).not.toMatch(/\{\{/);
  });

  it('writes a label on one line', () => {
    expect(fillLabel('Total {{total}}\n(TTC)', { total: '12,00' }, order.variables)).toBe(
      'Total 12,00 (TTC)',
    );
  });
});
