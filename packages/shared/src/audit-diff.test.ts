import { describe, expect, it } from 'vitest';
import { diffJson, flattenJson, inlineDiff } from './audit-diff';

describe('flattenJson', () => {
  it('flattens objects and arrays to dotted paths, keeping empty containers', () => {
    const m = flattenJson({ a: 1, b: { c: 'x', d: [1, { e: true }] }, f: {}, g: [] });
    expect([...m.entries()]).toEqual([
      ['a', '1'],
      ['b.c', '"x"'],
      ['b.d[0]', '1'],
      ['b.d[1].e', 'true'],
      ['f', '{}'],
      ['g', '[]'],
    ]);
  });
});

describe('diffJson', () => {
  it('tells what changed, what was added and what was removed', () => {
    const rows = diffJson(
      { name: 'Ana', city: 'Paris', age: 3 },
      { name: 'Anne', city: 'Paris', zip: '60' },
    );
    expect(rows).toEqual([
      { path: 'name', kind: 'changed', before: '"Ana"', after: '"Anne"' },
      { path: 'city', kind: 'same', before: '"Paris"', after: '"Paris"' },
      { path: 'zip', kind: 'added', after: '"60"' },
      { path: 'age', kind: 'removed', before: '3' },
    ]);
  });
  it('a creation is all added, a deletion all removed', () => {
    expect(diffJson(null, { a: 1 })).toEqual([{ path: 'a', kind: 'added', after: '1' }]);
    expect(diffJson({ a: 1 }, null)).toEqual([{ path: 'a', kind: 'removed', before: '1' }]);
    expect(diffJson(null, null)).toEqual([]);
  });
  it('compares nested values and arrays by position', () => {
    const rows = diffJson({ roles: ['A', 'B'] }, { roles: ['A', 'C', 'D'] });
    expect(rows.map((r) => [r.path, r.kind])).toEqual([
      ['roles[0]', 'same'],
      ['roles[1]', 'changed'],
      ['roles[2]', 'added'],
    ]);
  });
});

describe('inlineDiff', () => {
  it('isolates the differing middle of two strings', () => {
    expect(inlineDiff('"Dupont"', '"Dupond"')).toEqual({
      prefix: '"Dupon',
      oldMid: 't',
      newMid: 'd',
      suffix: '"',
    });
    expect(inlineDiff('abc', 'abc')).toEqual({ prefix: 'abc', oldMid: '', newMid: '', suffix: '' });
  });
});
