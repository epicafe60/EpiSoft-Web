import { z } from 'zod';

// Customer reviews of products (shop). Pure rules.

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'HIDDEN'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  PENDING: 'À modérer',
  APPROVED: 'Publié',
  HIDDEN: 'Masqué',
};

export const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z
    .string()
    .trim()
    .max(500)
    .transform((c) => (c === '' ? null : c))
    .nullable()
    .default(null),
});
export type ReviewInput = z.infer<typeof reviewSchema>;

/** Average to one decimal and count; null average without any rating. */
export function ratingSummary(ratings: readonly number[]): {
  average: number | null;
  count: number;
} {
  if (ratings.length === 0) return { average: null, count: 0 };
  const sum = ratings.reduce((s, r) => s + r, 0);
  return { average: Math.round((sum / ratings.length) * 10) / 10, count: ratings.length };
}

/** "Anne D." — reviews never show a full name. */
export function reviewAuthor(firstName: string, lastName: string): string {
  const initial = lastName.trim().charAt(0).toUpperCase();
  return initial ? `${firstName.trim()} ${initial}.` : firstName.trim();
}
