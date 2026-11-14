import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchOf } from './patch';
import { memberPatchSchema, productPatchSchema } from './forms';

describe('patchOf (R-MBR-09: only the fields present are changed)', () => {
  const shape = { name: z.string().min(1), visible: z.boolean().default(true), n: z.number() };

  it('every field is optional, and an absent field stays absent', () => {
    expect(patchOf(shape).parse({})).toEqual({});
    expect(patchOf(shape).parse({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('a default is never applied: a PATCH without it must not reset the field', () => {
    // z.object(shape).partial() would answer { visible: true } here and silently reset the field.
    expect('visible' in patchOf(shape).parse({ n: 1 })).toBe(false);
    expect(patchOf(shape).parse({ visible: false })).toEqual({ visible: false });
  });

  it('a field that is present is still validated', () => {
    expect(patchOf(shape).safeParse({ name: '' }).success).toBe(false);
    expect(patchOf(shape).safeParse({ n: 'a' }).success).toBe(false);
  });

  it('the real PATCH bodies keep what they do not mention', () => {
    const at = { updatedAt: '2026-11-08T10:00:00.000Z' };
    expect(Object.keys(memberPatchSchema.parse(at))).toEqual(['updatedAt']);
    expect(Object.keys(productPatchSchema.parse(at))).toEqual(['updatedAt']);
  });
});
