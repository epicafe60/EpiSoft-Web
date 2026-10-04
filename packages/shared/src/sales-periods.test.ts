import { describe, expect, it } from 'vitest';
import {
  defaultProposalStart,
  linesSignature,
  proposalState,
  salesPeriodOf,
} from './sales-periods';

describe('salesPeriodOf', () => {
  it('a day is its own period', () => {
    expect(salesPeriodOf('2026-07-01', 'DAY')).toMatchObject({
      key: 'D:2026-07-01',
      from: '2026-07-01',
      to: '2026-07-01',
    });
  });
  it('a week runs Monday to Sunday, any day of it gives the same key', () => {
    const wed = salesPeriodOf('2026-07-01', 'WEEK');
    expect(wed).toMatchObject({ key: 'W:2026-06-29', from: '2026-06-29', to: '2026-07-05' });
    expect(wed.label).toBe('Ventes semaine 27 (29/06/2026 au 05/07/2026)');
    expect(salesPeriodOf('2026-06-29', 'WEEK').key).toBe(wed.key);
    expect(salesPeriodOf('2026-07-05', 'WEEK').key).toBe(wed.key);
    expect(salesPeriodOf('2026-07-06', 'WEEK').key).not.toBe(wed.key);
  });
  it('a week is cut at the turn of the year (one fiscal year per entry)', () => {
    // 2026-12-31 is a Thursday; the week is 28/12 to 03/01.
    expect(salesPeriodOf('2026-12-31', 'WEEK')).toMatchObject({
      from: '2026-12-28',
      to: '2026-12-31',
    });
    expect(salesPeriodOf('2027-01-01', 'WEEK')).toMatchObject({
      from: '2027-01-01',
      to: '2027-01-03',
    });
  });
});

describe('proposal helpers', () => {
  it('starts the day after the last manual entry, or at the first session', () => {
    expect(defaultProposalStart('2026-06-27', '2026-04-08')).toBe('2026-06-28');
    expect(defaultProposalStart(null, '2026-04-08')).toBe('2026-04-08');
    expect(defaultProposalStart(null, null)).toBeNull();
  });
  it('tells what to do with an existing entry', () => {
    expect(proposalState(null, false)).toBe('NEW');
    expect(proposalState({ status: 'DRAFT' }, true)).toBe('UP_TO_DATE');
    expect(proposalState({ status: 'DRAFT' }, false)).toBe('OUTDATED_DRAFT');
    expect(proposalState({ status: 'VALIDATED' }, false)).toBe('DIFFERS_VALIDATED');
  });
  it('compares lines whatever their order', () => {
    const a = [
      { account: '530000', debitCents: 100, creditCents: 0 },
      { account: '707000', debitCents: 0, creditCents: 100 },
    ];
    expect(linesSignature(a)).toBe(linesSignature([...a].reverse()));
    expect(linesSignature(a)).not.toBe(linesSignature([{ ...a[0]!, debitCents: 101 }, a[1]!]));
  });
});
