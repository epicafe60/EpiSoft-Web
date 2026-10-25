import { describe, expect, it } from 'vitest';
import { isRedacted, orderSteps, planRestore, rowId, sameValue, type RowChange } from './revert';

// R-ADM-06: undoing an action puts back the values it changed, and refuses to erase a change made
// since.

const K = { id: 'p1' };
let n = 0;
const ch = (c: Omit<RowChange, 'id' | 'table' | 'key'> & Partial<RowChange>): RowChange => ({
  id: ++n,
  table: 'product',
  key: K,
  ...c,
});
const state = (rows: Record<string, Record<string, unknown> | null>) => (id: string) =>
  rows[id] ?? null;

describe('planRestore (R-ADM-06)', () => {
  it('puts back the columns an update changed', () => {
    const plan = planRestore(
      [ch({ op: 'U', old: { sale_price: 2.5, name: 'A' }, new: { sale_price: 3, name: 'B' } })],
      state({ [rowId('product', K)]: { id: 'p1', sale_price: 3, name: 'B', stock_qty: 7 } }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.steps).toEqual([
      { table: 'product', key: K, kind: 'update', set: { sale_price: 2.5, name: 'A' } },
    ]);
  });

  it('refuses when a column was changed again since, and names it', () => {
    const plan = planRestore(
      [ch({ op: 'U', old: { sale_price: 2.5 }, new: { sale_price: 3 } })],
      state({ [rowId('product', K)]: { id: 'p1', sale_price: 3.2 } }),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.conflicts).toEqual([
      { table: 'product', key: K, kind: 'changed', columns: ['sale_price'] },
    ]);
  });

  it('ignores the columns the action did not touch', () => {
    const plan = planRestore(
      [ch({ op: 'U', old: { name: 'A' }, new: { name: 'B' } })],
      state({ [rowId('product', K)]: { id: 'p1', name: 'B', stock_qty: 99 } }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.steps).toHaveLength(1);
  });

  it('the time of the last change is neither a conflict nor a reason to write', () => {
    const touched = ch({
      op: 'U',
      old: { name: 'A', updated_at: '2026-10-01T10:00:00+02:00' },
      new: { name: 'B', updated_at: '2026-10-02T10:00:00+02:00' },
    });
    const plan = planRestore(
      [touched],
      state({
        [rowId('product', K)]: { id: 'p1', name: 'B', updated_at: '2026-10-20T10:00:00+02:00' },
      }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    const onlyTime = ch({
      op: 'U',
      old: { updated_at: '2026-10-01T10:00:00+02:00' },
      new: { updated_at: '2026-10-02T10:00:00+02:00' },
    });
    expect(planRestore([onlyTime], state({ [rowId('product', K)]: { id: 'p1' } }))).toEqual({
      steps: [],
      conflicts: [],
    });
  });

  it('refuses when the row was deleted since', () => {
    const plan = planRestore([ch({ op: 'U', old: { name: 'A' }, new: { name: 'B' } })], state({}));
    expect(plan.conflicts).toEqual([{ table: 'product', key: K, kind: 'deleted' }]);
  });

  it('deletes a row the action created, unless it changed since', () => {
    const created = ch({ op: 'I', old: null, new: { id: 'p1', name: 'B' } });
    expect(
      planRestore([created], state({ [rowId('product', K)]: { id: 'p1', name: 'B' } })).steps,
    ).toEqual([{ table: 'product', key: K, kind: 'delete' }]);
    expect(
      planRestore([created], state({ [rowId('product', K)]: { id: 'p1', name: 'C' } })).conflicts,
    ).toEqual([{ table: 'product', key: K, kind: 'changed', columns: ['name'] }]);
    // Already gone: nothing to do.
    expect(planRestore([created], state({}))).toEqual({ steps: [], conflicts: [] });
  });

  it('creates again a row the action deleted, unless the key is taken', () => {
    const deleted = ch({ op: 'D', old: { id: 'p1', name: 'A' }, new: null });
    expect(planRestore([deleted], state({})).steps).toEqual([
      { table: 'product', key: K, kind: 'insert', row: { id: 'p1', name: 'A' } },
    ]);
    expect(
      planRestore([deleted], state({ [rowId('product', K)]: { id: 'p1', name: 'X' } })).conflicts,
    ).toEqual([{ table: 'product', key: K, kind: 'exists' }]);
  });

  it('takes several changes of a row together: earliest value back, latest value expected', () => {
    const plan = planRestore(
      [
        ch({ op: 'U', old: { name: 'A' }, new: { name: 'B' } }),
        ch({ op: 'U', old: { name: 'B', sale_price: 1 }, new: { name: 'C', sale_price: 2 } }),
      ],
      state({ [rowId('product', K)]: { id: 'p1', name: 'C', sale_price: 2 } }),
    );
    expect(plan.steps).toEqual([
      { table: 'product', key: K, kind: 'update', set: { name: 'A', sale_price: 1 } },
    ]);
  });

  it('a row created then deleted by the same action needs nothing', () => {
    const plan = planRestore(
      [
        ch({ op: 'I', old: null, new: { id: 'p1', name: 'A' } }),
        ch({ op: 'D', old: { id: 'p1', name: 'A' }, new: null }),
      ],
      state({}),
    );
    expect(plan).toEqual({ steps: [], conflicts: [] });
  });

  it('cannot put back a secret or a file, which were not recorded', () => {
    const plan = planRestore(
      [
        ch({
          table: 'member',
          op: 'U',
          old: { password_hash: '***' },
          new: { password_hash: '***' },
        }),
      ],
      state({ [rowId('member', K)]: { id: 'p1', password_hash: 'argon…' } }),
    );
    // Same "***" on both sides: no visible change, nothing to do.
    expect(plan).toEqual({ steps: [], conflicts: [] });
    const deleted = planRestore(
      [ch({ table: 'media', op: 'D', old: { id: 'p1', bytes: { octets: 1200 } }, new: null })],
      state({}),
    );
    expect(deleted.conflicts).toEqual([
      { table: 'media', key: K, kind: 'secret', columns: ['bytes'] },
    ]);
  });

  it('a table without primary key cannot be undone', () => {
    const plan = planRestore([ch({ key: null, op: 'U', old: { a: 1 }, new: { a: 2 } })], state({}));
    expect(plan.conflicts).toEqual([{ table: 'product', key: null, kind: 'nokey' }]);
  });

  it('orders the writes from the last row touched to the first (children before parents)', () => {
    const cat = { id: 'c1' };
    const plan = planRestore(
      [
        ch({ table: 'category', key: cat, op: 'I', old: null, new: { id: 'c1' } }),
        ch({ op: 'I', old: null, new: { id: 'p1', category_id: 'c1' } }),
      ],
      state({
        [rowId('category', cat)]: { id: 'c1' },
        [rowId('product', K)]: { id: 'p1', category_id: 'c1' },
      }),
    );
    expect(plan.steps.map((s) => s.table)).toEqual(['product', 'category']);
  });
});

describe('comparing recorded values', () => {
  it('compares timestamps as instants, whatever the offset', () => {
    expect(sameValue('2026-10-24T19:37:41.123456+02:00', '2026-10-24T17:37:41.123456+00:00')).toBe(
      true,
    );
    expect(sameValue('2026-10-24T19:37:41.123456+02:00', '2026-10-24T19:37:41.123457+02:00')).toBe(
      false,
    );
  });

  it('compares objects whatever the order of their keys', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(
      true,
    );
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue(null, 0)).toBe(false);
  });

  it('recognises what the capture writes instead of secrets and files', () => {
    expect(isRedacted('***')).toBe(true);
    expect(isRedacted({ octets: 10 })).toBe(true);
    expect(isRedacted({ octets: 10, x: 1 })).toBe(false);
    expect(isRedacted('abc')).toBe(false);
  });
});

describe('orderSteps (R-ADM-06)', () => {
  const parents = (t: string) =>
    ({
      purchase_order_line: ['purchase_order', 'product'],
      purchase_order: ['supplier'],
      product: ['supplier', 'product'],
    })[t] ?? [];
  const k = { id: 'x' };

  it('creates parents before children and removes children before parents', () => {
    const ordered = orderSteps(
      [
        { table: 'purchase_order_line', key: k, kind: 'delete' },
        { table: 'purchase_order', key: k, kind: 'delete' },
        { table: 'purchase_order_line', key: k, kind: 'insert', row: {} },
        { table: 'product', key: k, kind: 'update', set: {} },
        { table: 'purchase_order', key: k, kind: 'insert', row: {} },
        { table: 'supplier', key: k, kind: 'delete' },
      ],
      parents,
    );
    expect(ordered.map((s) => `${s.kind} ${s.table}`)).toEqual([
      'insert purchase_order',
      'insert purchase_order_line',
      'update product',
      'delete purchase_order_line',
      'delete purchase_order',
      'delete supplier',
    ]);
  });

  it('survives a table that points to itself or a cycle', () => {
    const cyclic = (t: string) => ({ a: ['b'], b: ['a'] })[t] ?? [];
    const ordered = orderSteps(
      [
        { table: 'a', key: k, kind: 'insert', row: {} },
        { table: 'b', key: k, kind: 'insert', row: {} },
      ],
      cyclic,
    );
    expect(ordered).toHaveLength(2);
  });
});
