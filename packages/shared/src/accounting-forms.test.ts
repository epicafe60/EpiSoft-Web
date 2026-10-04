import { describe, expect, it } from 'vitest';
import {
  ENTRY_MODES,
  accountSchema,
  entryInputSchema,
  entryModeFromLegacy,
  fiscalYearSchema,
  journalSchema,
  templateSchema,
} from './accounting-forms';

const id = () => crypto.randomUUID();

describe('entryModeFromLegacy (§C)', () => {
  it('maps 0–5 and rejects the rest', () => {
    expect([0, 1, 2, 3, 4, 5].map(entryModeFromLegacy)).toEqual([...ENTRY_MODES]);
    expect(entryModeFromLegacy(null)).toBeNull();
    expect(entryModeFromLegacy(6)).toBeNull();
  });
});

describe('accountSchema', () => {
  it('requires a 6-digit number and a label', () => {
    const ok = { number: '411000', label: 'Adhérents', normalSide: 'C' as const, active: true };
    expect(accountSchema.safeParse(ok).success).toBe(true);
    expect(accountSchema.safeParse({ ...ok, number: '41100' }).success).toBe(false);
    expect(accountSchema.safeParse({ ...ok, number: '41100a' }).success).toBe(false);
    expect(accountSchema.safeParse({ ...ok, label: ' ' }).success).toBe(false);
    expect(accountSchema.safeParse({ ...ok, normalSide: 'X' }).success).toBe(false);
  });
});

describe('journalSchema', () => {
  it('upper-cases the code and limits it to 5 characters', () => {
    expect(journalSchema.parse({ code: 'vte', label: 'Ventes', active: true }).code).toBe('VTE');
    expect(journalSchema.safeParse({ code: 'ABCDEF', label: 'x', active: true }).success).toBe(
      false,
    );
    expect(journalSchema.safeParse({ code: 'A-1', label: 'x', active: true }).success).toBe(false);
  });
});

describe('fiscalYearSchema', () => {
  it('refuses an end before the start', () => {
    const fy = (startDate: string, endDate: string) =>
      fiscalYearSchema.safeParse({ label: '2026', startDate, endDate }).success;
    expect(fy('2026-01-01', '2026-12-31')).toBe(true);
    expect(fy('2026-01-01', '2026-01-01')).toBe(true);
    expect(fy('2026-02-01', '2026-01-31')).toBe(false);
    expect(fy('1/1/2026', '2026-12-31')).toBe(false);
  });
});

describe('entryInputSchema', () => {
  const base = () => ({
    journalId: id(),
    date: '2026-10-01',
    pieceRef: '  ',
    label: 'Test',
    mode: null,
    lines: [
      { accountId: id(), debit: '12,5', credit: '' },
      { accountId: id(), debit: '', credit: '12.50' },
    ],
  });
  it('normalises amounts, empty means zero, blank piece becomes null', () => {
    const r = entryInputSchema.parse(base());
    expect(r.pieceRef).toBeNull();
    expect(r.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['12.50', '0.00'],
      ['0.00', '12.50'],
    ]);
    expect(r.lines[0]!.label).toBe('');
  });
  it('rejects a bad date, label, account or amount', () => {
    expect(entryInputSchema.safeParse({ ...base(), date: '01/10/2026' }).success).toBe(false);
    expect(entryInputSchema.safeParse({ ...base(), label: '' }).success).toBe(false);
    const b = base();
    (b.lines[0] as { accountId: string }).accountId = 'x';
    expect(entryInputSchema.safeParse(b).success).toBe(false);
    const c = base();
    c.lines[0]!.debit = 'abc';
    expect(entryInputSchema.safeParse(c).success).toBe(false);
  });
});

describe('templateSchema', () => {
  const line = (debit = '') => ({ accountId: id(), label: '', debit, credit: '' });
  const base = { categoryCode: null, journalId: id(), label: 'Guide', mode: null, active: true };
  it('needs at least two lines; blank amounts become null', () => {
    expect(templateSchema.safeParse({ ...base, lines: [line()] }).success).toBe(false);
    const r = templateSchema.parse({ ...base, lines: [line('5'), line()] });
    expect(r.lines[0]!.debit).toBe('5.00');
    expect(r.lines[1]!.debit).toBeNull();
  });
});
