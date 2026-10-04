import { describe, expect, it } from 'vitest';
import { ratingSummary, reviewAuthor, reviewSchema } from './reviews';

describe('reviews', () => {
  it('averages to one decimal', () => {
    expect(ratingSummary([5, 4, 4])).toEqual({ average: 4.3, count: 3 });
    expect(ratingSummary([])).toEqual({ average: null, count: 0 });
  });
  it('validates the rating and trims the comment', () => {
    expect(reviewSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(reviewSchema.parse({ rating: 4, comment: '  bon  ' }).comment).toBe('bon');
    expect(reviewSchema.parse({ rating: 4, comment: '   ' }).comment).toBeNull();
  });
  it('shows an abbreviated author', () => {
    expect(reviewAuthor('Anne', 'Dupont')).toBe('Anne D.');
  });
});
