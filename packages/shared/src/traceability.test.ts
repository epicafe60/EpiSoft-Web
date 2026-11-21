import { describe, expect, it } from 'vitest';
import { allocateFefo, lotNumberProblem, receiptLotProblem } from './traceability';

// Règlement CE 178/2002, art. 18: the lots a sale may come from, estimated first expired, first out.

const lot = (id: string, receivedOn: string, bestBefore: string | null, qty: number) => ({
  id,
  receivedOn,
  bestBefore,
  qtyMilli: qty * 1000,
});
const out = (id: string, day: string, qty: number, time = '10:00') => ({
  id,
  day,
  at: `${day}T${time}:00Z`,
  qtyMilli: qty * 1000,
});

describe('allocateFefo', () => {
  it('serves the earliest best-before date first, whatever the order of reception', () => {
    const r = allocateFefo(
      [lot('A', '2026-11-01', '2026-12-31', 5), lot('B', '2026-11-02', '2026-11-20', 5)],
      [out('s1', '2026-11-03', 6)],
    );
    expect(r.allocations).toEqual([
      { outId: 's1', lotId: 'B', qtyMilli: 5000 },
      { outId: 's1', lotId: 'A', qtyMilli: 1000 },
    ]);
    expect(r.remaining.get('A')).toBe(4000);
    expect(r.unallocated).toEqual([]);
  });

  it('never takes from a lot before the day it is received', () => {
    const r = allocateFefo(
      [lot('A', '2026-11-01', '2026-12-31', 2), lot('B', '2026-11-10', '2026-11-12', 5)],
      [out('s1', '2026-11-05', 1), out('s2', '2026-11-10', 3)],
    );
    expect(r.allocations.find((a) => a.outId === 's1')!.lotId).toBe('A');
    // On the day B arrives it is available, and it expires first.
    expect(r.allocations.filter((a) => a.outId === 's2').map((a) => a.lotId)).toEqual(['B']);
  });

  it('reports what no lot can explain', () => {
    const r = allocateFefo([lot('A', '2026-11-01', null, 2)], [out('s1', '2026-11-02', 5)]);
    expect(r.unallocated).toEqual([{ outId: 's1', qtyMilli: 3000 }]);
    expect(r.remaining.get('A')).toBe(0);
  });

  it('puts a lot without a date after the dated ones, then the oldest reception first', () => {
    const r = allocateFefo(
      [
        lot('N2', '2026-11-02', null, 1),
        lot('N1', '2026-11-01', null, 1),
        lot('D', '2026-11-03', '2027-01-01', 1),
      ],
      [out('s1', '2026-11-04', 3)],
    );
    expect(r.allocations.map((a) => a.lotId)).toEqual(['D', 'N1', 'N2']);
  });

  it('replays the exits in order of time, not in the order given', () => {
    const r = allocateFefo(
      [lot('A', '2026-11-01', '2026-11-30', 1)],
      [out('late', '2026-11-02', 1, '16:00'), out('early', '2026-11-02', 1, '09:00')],
    );
    expect(r.allocations).toEqual([{ outId: 'early', lotId: 'A', qtyMilli: 1000 }]);
    expect(r.unallocated).toEqual([{ outId: 'late', qtyMilli: 1000 }]);
  });
});

describe('lotNumberProblem', () => {
  it.each(['', ' ', 'a', '0', '000', 'N/A', 'néant', '??', 'xx'])('refuses %j', (v) => {
    expect(lotNumberProblem(v)).not.toBeNull();
  });
  it('accepts what is printed on a pack', () => {
    expect(lotNumberProblem('L2411-07')).toBeNull();
    expect(lotNumberProblem('  23/11/B  ')).toBeNull();
  });
});

describe('receiptLotProblem', () => {
  const food = { name: 'Yaourt', isFood: true, kind: 'GOODS', originFamily: null };
  it('does not ask a lot for what is not food', () => {
    expect(
      receiptLotProblem({ ...food, isFood: false }, { lotNumber: null, bestBefore: null }),
    ).toBeNull();
  });
  it('asks the lot number and the date for a food product', () => {
    expect(receiptLotProblem(food, { lotNumber: null, bestBefore: '2026-12-01' })).toMatch(/lot/);
    expect(receiptLotProblem(food, { lotNumber: 'L1', bestBefore: null })).toMatch(/DLC/);
    expect(receiptLotProblem(food, { lotNumber: 'L1', bestBefore: '2026-12-01' })).toBeNull();
  });
  it('lets fresh fruit and vegetables go without a date', () => {
    expect(
      receiptLotProblem(
        { ...food, originFamily: 'FRUIT_VEG' },
        { lotNumber: 'L1', bestBefore: null },
      ),
    ).toBeNull();
  });
});
