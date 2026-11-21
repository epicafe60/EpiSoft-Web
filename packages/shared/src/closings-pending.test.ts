import { describe, expect, it } from 'vitest';
import { pendingClosings, periodEndOf, type PendingClosingsInput } from './closings-pending';

// ADR 0016 §3: what is left to close, and what can be closed now.

const base: PendingClosingsInput = {
  today: '2026-05-10',
  salesByDay: [],
  closed: { DAY: [], MONTH: [], YEAR: [] },
  openSessionDays: [],
};

describe('periodEndOf', () => {
  it('ends a day, a month and a year', () => {
    expect(periodEndOf('DAY', '2026-04-12')).toBe('2026-04-12');
    expect(periodEndOf('MONTH', '2026-02-01')).toBe('2026-02-28');
    expect(periodEndOf('MONTH', '2028-02-01')).toBe('2028-02-29');
    expect(periodEndOf('YEAR', '2026-01-01')).toBe('2026-12-31');
  });
});

describe('pendingClosings', () => {
  it('has nothing to close without tickets', () => {
    expect(pendingClosings(base)).toEqual([]);
  });

  it('lets only the oldest day be closed, the others wait their turn', () => {
    const r = pendingClosings({
      ...base,
      salesByDay: [
        { day: '2026-05-08', tickets: 4 },
        { day: '2026-05-06', tickets: 9 },
      ],
    });
    expect(r.map((x) => [x.start, x.ready])).toEqual([
      ['2026-05-06', true],
      ['2026-05-08', false],
    ]);
    expect(r[1]!.reason).toMatch(/journée précédente/);
  });

  it('refuses a day while a drawer opened that day or before is still open', () => {
    const r = pendingClosings({
      ...base,
      salesByDay: [{ day: '2026-05-06', tickets: 3 }],
      openSessionDays: ['2026-05-06'],
    });
    expect(r[0]).toMatchObject({ ready: false });
    expect(r[0]!.reason).toMatch(/session de caisse/);
    // A drawer opened later does not hold an earlier day.
    expect(
      pendingClosings({
        ...base,
        salesByDay: [{ day: '2026-05-06', tickets: 3 }],
        openSessionDays: ['2026-05-09'],
      })[0]!.ready,
    ).toBe(true);
  });

  it('lets today be closed once the drawer is closed, never a day to come', () => {
    expect(
      pendingClosings({ ...base, salesByDay: [{ day: '2026-05-10', tickets: 2 }] })[0]!.ready,
    ).toBe(true);
    expect(
      pendingClosings({ ...base, salesByDay: [{ day: '2026-05-11', tickets: 2 }] })[0],
    ).toMatchObject({
      ready: false,
      reason: 'Une journée à venir ne se clôture pas.',
    });
  });

  it('flags a day older than the last closed day (it can no longer be closed)', () => {
    const r = pendingClosings({
      ...base,
      salesByDay: [{ day: '2026-05-04', tickets: 1 }],
      closed: { DAY: ['2026-05-06'], MONTH: [], YEAR: [] },
    });
    expect(r[0]).toMatchObject({ ready: false });
    expect(r[0]!.reason).toMatch(/déjà clôturé/);
  });

  it('proposes a month once it is over, ready when all its days are closed', () => {
    const salesByDay = [
      { day: '2026-04-02', tickets: 5 },
      { day: '2026-04-20', tickets: 7 },
    ];
    const notYet = pendingClosings({
      ...base,
      salesByDay,
      closed: { DAY: ['2026-04-02'], MONTH: [], YEAR: [] },
    });
    const month = notYet.find((x) => x.kind === 'MONTH')!;
    expect(month).toMatchObject({
      start: '2026-04-01',
      end: '2026-04-30',
      tickets: 12,
      ready: false,
    });
    expect(month.reason).toContain('20/04/2026');
    const done = pendingClosings({
      ...base,
      salesByDay,
      closed: { DAY: ['2026-04-02', '2026-04-20'], MONTH: [], YEAR: [] },
    });
    expect(done.map((x) => [x.kind, x.start, x.ready])).toEqual([['MONTH', '2026-04-01', true]]);
  });

  it('does not propose the current month, nor a closed one', () => {
    const r = pendingClosings({
      ...base,
      salesByDay: [
        { day: '2026-05-02', tickets: 1 },
        { day: '2026-03-02', tickets: 1 },
      ],
      closed: { DAY: ['2026-05-02', '2026-03-02'], MONTH: ['2026-03-01'], YEAR: [] },
    });
    expect(r).toEqual([]);
  });

  it('proposes a year once it is over, ready when all its months with tickets are closed', () => {
    const salesByDay = [{ day: '2025-11-05', tickets: 3 }];
    const waiting = pendingClosings({
      ...base,
      salesByDay,
      closed: { DAY: ['2025-11-05'], MONTH: [], YEAR: [] },
    });
    expect(waiting.map((x) => [x.kind, x.ready])).toEqual([
      ['MONTH', true],
      ['YEAR', false],
    ]);
    expect(waiting[1]!.reason).toContain('11/2025');
    const ready = pendingClosings({
      ...base,
      salesByDay,
      closed: { DAY: ['2025-11-05'], MONTH: ['2025-11-01'], YEAR: [] },
    });
    expect(ready).toEqual([
      {
        kind: 'YEAR',
        start: '2025-01-01',
        end: '2025-12-31',
        tickets: 3,
        ready: true,
        reason: null,
      },
    ]);
  });
});
