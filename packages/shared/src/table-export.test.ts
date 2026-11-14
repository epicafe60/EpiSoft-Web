import { describe, expect, it } from 'vitest';
import { ROLE_CODES, type RoleCode } from './roles';
import {
  canExport,
  exportFileName,
  exportRolesOf,
  exportScopeOfPath,
  parseFrenchDate,
  parseFrenchNumber,
  tableExportSchema,
  typeColumns,
} from './table-export';

describe('who may export from which screen', () => {
  it('finds the screen of a page, the most specific first', () => {
    expect(exportScopeOfPath('/membres/foyers/3?x=1')).toBe('membres');
    expect(exportScopeOfPath('/foyers/12')).toBe('foyers');
    expect(exportScopeOfPath('/signalements/gestion')).toBe('signalements-gestion');
    expect(exportScopeOfPath('/signalements/abc')).toBe('perso');
    expect(exportScopeOfPath('/boutique')).toBe('perso');
    expect(exportScopeOfPath('/')).toBe('accueil');
    // Not a lookalike, and an unknown page is the strictest scope.
    expect(exportScopeOfPath('/membresX')).toBe('admin');
    expect(exportScopeOfPath('/inconnu')).toBe('admin');
  });

  it('asks for the role that opens the screen, and an administrator opens all', () => {
    expect(canExport(['ADHERENTS'], 'membres')).toBe(true);
    expect(canExport(['CAISSE'], 'membres')).toBe(false);
    expect(canExport(['COMPTA'], 'compta')).toBe(true);
    expect(canExport(['APPROS'], 'compta')).toBe(false);
    expect(canExport(['COMPTA'], 'surveillance')).toBe(true);
    expect(canExport(['PRODUITS'], 'surveillance')).toBe(false);
    for (const scope of ['membres', 'compta', 'admin', 'caisse', 'signalements-gestion'] as const)
      expect(canExport(['ADMIN'], scope)).toBe(true);
  });

  it('keeps the administration and the management of reports for the administrators', () => {
    for (const r of ROLE_CODES.filter((x) => x !== 'ADMIN') as RoleCode[]) {
      expect(canExport([r], 'admin')).toBe(false);
      expect(canExport([r], 'signalements-gestion')).toBe(false);
    }
  });

  it('opens one’s own screens to every signed-in person', () => {
    expect(exportRolesOf('perso')).toEqual([]);
    expect(canExport([], 'perso')).toBe(true);
    expect(canExport([], 'accueil')).toBe(true);
    expect(canExport([], 'membres')).toBe(false);
  });
});

describe('typing the columns of a list', () => {
  it('turns amounts, numbers and dates into real values, and leaves the rest as text', () => {
    const { columns, rows } = typeColumns(
      ['Libellé', 'Montant', 'Quantité', 'Date', 'Heure'],
      [
        ['Lentilles', '12,50 €', '3', '14/11/2026', '14/11/2026 10:30'],
        ['Miel', '1 234,00 €', '1 200', '01/02/2026', '15/11/2026 08:05'],
        ['Thé', '', '', '', ''],
      ],
    );
    expect(columns.map((c) => c.type)).toEqual(['text', 'money', 'number', 'date', 'datetime']);
    expect(rows[0]).toEqual(['Lentilles', 12.5, 3, '2026-11-14', '2026-11-14T10:30']);
    expect(rows[1]).toEqual(['Miel', 1234, 1200, '2026-02-01', '2026-11-15T08:05']);
    expect(rows[2]).toEqual(['Thé', null, null, null, null]);
  });

  it('never alters a code, a leading zero or a doubtful column', () => {
    const { columns, rows } = typeColumns(
      ['Code', 'EAN', 'Stock', 'Prix'],
      [
        ['01001', '3760123456789', '5', '2,50 €'],
        ['01002', '3760123456790', 'beaucoup', '3 €'],
      ],
    );
    expect(columns.map((c) => c.type)).toEqual(['text', 'text', 'text', 'money']);
    expect(rows[0]![0]).toBe('01001');
    expect(rows[0]![2]).toBe('5');
  });

  it('keeps a leading-zero number and an impossible date as text', () => {
    expect(typeColumns(['A'], [['007']]).columns[0]!.type).toBe('text');
    expect(typeColumns(['A'], [['31/02/2026']]).columns[0]!.type).toBe('text');
    expect(parseFrenchDate('31/02/2026')).toBeNull();
    expect(parseFrenchDate('14/11/2026 24:00')).toBeNull();
    expect(parseFrenchNumber('-3,5')).toBe(-3.5);
    expect(parseFrenchNumber('abc')).toBeNull();
  });
});

describe('the export request', () => {
  const ok = {
    scope: 'membres',
    title: 'Membres',
    columns: [
      { header: 'Nom', type: 'text' },
      { header: 'Solde', type: 'money' },
      { header: 'Depuis', type: 'date' },
    ],
    rows: [['DUPONT', 12.5, '2026-11-14']],
  };

  it('accepts what typeColumns produces', () => {
    expect(tableExportSchema.safeParse(ok).success).toBe(true);
  });

  it('refuses an unknown screen, a ragged row, a wrong type and an oversized request', () => {
    for (const bad of [
      { ...ok, scope: 'secret' },
      { ...ok, rows: [['DUPONT', 12.5]] },
      { ...ok, rows: [['DUPONT', '12,50', '2026-11-14']] },
      { ...ok, rows: [['DUPONT', 12.5, '14/11/2026']] },
      { ...ok, rows: [[1, 12.5, '2026-11-14']] },
      { ...ok, columns: [] },
      { ...ok, title: ' ' },
      { ...ok, rows: Array.from({ length: 20_001 }, () => ['A', 1, '2026-11-14']) },
      { ...ok, rows: [['x'.repeat(2001), 1, '2026-11-14']] },
    ])
      expect(tableExportSchema.safeParse(bad).success).toBe(false);
  });

  it('names the file with letters, digits and dashes only', () => {
    expect(exportFileName('Écritures comptables / 2026', '2026-11-14')).toBe(
      'Ecritures-comptables-2026-2026-11-14.xlsx',
    );
    expect(exportFileName('../../etc/"passwd"', '2026-11-14')).toBe('etc-passwd-2026-11-14.xlsx');
    expect(exportFileName('???', '2026-11-14')).toBe('export-2026-11-14.xlsx');
  });
});
