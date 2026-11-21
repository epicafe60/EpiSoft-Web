import { describe, expect, it } from 'vitest';
import { checkFec, type FecCheckEntry } from './fec-check';

const entry = (over: Partial<FecCheckEntry> & { number: number | null }): FecCheckEntry => ({
  id: `e${over.number}`,
  journalCode: 'ACH',
  date: '2026-03-01',
  status: 'VALIDATED',
  pieceRef: 'F-1',
  label: 'Facture',
  validatedOn: '2026-03-02',
  lines: [
    { label: 'a', debitCents: 1000, creditCents: 0 },
    { label: 'b', debitCents: 0, creditCents: 1000 },
  ],
  ...over,
});

const run = (entries: FecCheckEntry[], siren: string | null = '123456789') =>
  checkFec({ entries, startDate: '2026-01-01', endDate: '2026-12-31', siren });

describe('FEC self-check', () => {
  it('finds nothing on a clean, continuous year', () => {
    expect(run([entry({ number: 1 }), entry({ number: 2 }), entry({ number: 3 })])).toEqual([]);
  });

  it('reports a gap and a duplicate in the numbering of a journal', () => {
    const gap = run([entry({ number: 1 }), entry({ number: 4 })]);
    expect(gap.map((a) => a.code)).toEqual(['NUMBER_GAP']);
    expect(gap[0]).toMatchObject({ severity: 'error', journalCode: 'ACH' });
    expect(gap[0]!.message).toContain('2 numéros manquants');
    const dup = run([entry({ number: 1 }), entry({ number: 1, id: 'dup' })]);
    expect(dup.map((a) => a.code)).toContain('NUMBER_DUPLICATE');
  });

  it('counts each journal on its own', () => {
    const ok = run([
      entry({ number: 1 }),
      entry({ number: 1, journalCode: 'BNQ', id: 'b1' }),
      entry({ number: 2 }),
    ]);
    expect(ok).toEqual([]);
  });

  it('reports unbalanced entries, drafts and dates out of the year', () => {
    const codes = run([
      entry({
        number: 1,
        lines: [
          { label: 'a', debitCents: 1000, creditCents: 0 },
          { label: 'b', debitCents: 0, creditCents: 900 },
        ],
      }),
      entry({ number: 2, date: '2027-01-02' }),
      entry({ number: null, status: 'DRAFT', id: 'd' }),
    ]).map((a) => a.code);
    expect(codes).toEqual(
      expect.arrayContaining(['UNBALANCED_ENTRY', 'TOTAL_UNBALANCED', 'DATE_OUT_OF_YEAR', 'DRAFT']),
    );
  });

  it('warns, without blocking, about a missing piece, a missing SIREN or a chronology inversion', () => {
    const found = run(
      [
        entry({ number: 1, date: '2026-05-01', validatedOn: '2026-06-01' }),
        entry({ number: 2, date: '2026-04-01', pieceRef: null, validatedOn: '2026-06-02' }),
      ],
      null,
    );
    expect(found.map((a) => a.code).sort()).toEqual([
      'MISSING_PIECE',
      'NOT_CHRONOLOGICAL',
      'NO_SIREN',
    ]);
    expect(found.every((a) => a.severity === 'warning')).toBe(true);
  });
});
