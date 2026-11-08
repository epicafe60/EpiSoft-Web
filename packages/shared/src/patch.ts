import { z } from 'zod';

type WithoutDefault<T> = T extends z.ZodDefault<infer I extends z.ZodType> ? I : T;

/** Shape of a PATCH body: every field optional, and no default value. */
export type PatchShape<S extends z.ZodRawShape> = {
  [K in keyof S]: z.ZodOptional<WithoutDefault<S[K]>>;
};

/**
 * Schema of a PATCH body built from the fields of a create form (R-MBR-09: only the fields present
 * are changed). zod 4 applies `.default()` even inside `.optional()`, so `z.object(f).partial()`
 * would fill in an absent field with its default and silently reset it (for example a member's
 * image consent, or a product hidden from the shop shown again). Defaults are removed first.
 */
export function patchOf<S extends z.ZodRawShape>(shape: S): z.ZodObject<PatchShape<S>> {
  const out: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) {
    const bare = (field instanceof z.ZodDefault ? field.unwrap() : field) as z.ZodType;
    out[key] = bare.optional();
  }
  return z.object(out) as unknown as z.ZodObject<PatchShape<S>>;
}
