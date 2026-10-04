import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { REVIEW_STATUS_LABELS, type ReviewStatus } from '@episoft/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field } from '@/components/ui/form';
import { Textarea } from '@/components/ui/inputs';

export type Ratings = Record<string, { average: number; count: number }>;

interface ReviewList {
  average: number | null;
  count: number;
  reviews: {
    id: string;
    rating: number;
    comment: string | null;
    status: ReviewStatus;
    createdAt: string;
    author: string;
    mine: boolean;
  }[];
}

const fr = (n: number) => String(n).replace('.', ',');

export function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex', className)} aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(
            'size-3.5',
            i <= Math.round(value) ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground',
          )}
        />
      ))}
    </span>
  );
}

/** The star rating of a product in the shop, opening its reviews. */
export function RatingButton({
  productId,
  name,
  rating,
}: {
  productId: string;
  name: string;
  rating?: { average: number; count: number } | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => setOpen(true)}
      >
        {rating ? (
          <>
            <Stars value={rating.average} />
            <span>
              {fr(rating.average)} ({rating.count}) <span className="sr-only">avis sur {name}</span>
            </span>
          </>
        ) : (
          <span>Donner un avis</span>
        )}
      </button>
      {open ? (
        <ReviewsDialog productId={productId} name={name} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ReviewsDialog({
  productId,
  name,
  onClose,
}: {
  productId: string;
  name: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['reviews', productId],
    queryFn: () => api.get<ReviewList>(`/shop/products/${productId}/reviews`),
  });
  const mine = data?.reviews.find((r) => r.mine);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const value = rating ?? mine?.rating ?? 0;
  const save = useMutation({
    mutationFn: () =>
      api.put(`/shop/products/${productId}/review`, {
        rating: value,
        comment: comment ?? mine?.comment ?? '',
      }),
    onSuccess: async () => {
      setRating(null);
      setComment(null);
      await queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
      await queryClient.invalidateQueries({ queryKey: ['shop-ratings'] });
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Avis sur ${name}`}
      description="Les avis sont publiés après modération."
    >
      <div className="grid gap-4">
        <ul className="grid max-h-64 gap-2 overflow-y-auto" aria-label="Avis">
          {data?.reviews.map((r) => (
            <li key={r.id} className="rounded-md border p-2 text-sm">
              <p className="flex items-center gap-2">
                <Stars value={r.rating} />
                <span className="sr-only">{r.rating} sur 5,</span>
                <strong>{r.author}</strong>
                <span className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>
                {r.mine && r.status !== 'APPROVED' ? (
                  <Badge variant="muted">{REVIEW_STATUS_LABELS[r.status]}</Badge>
                ) : null}
              </p>
              {r.comment ? <p className="mt-1">{r.comment}</p> : null}
            </li>
          ))}
          {data?.reviews.length === 0 ? (
            <li className="text-sm text-muted-foreground">Aucun avis pour l'instant.</li>
          ) : null}
        </ul>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (value >= 1) save.mutate();
          }}
        >
          <fieldset className="flex items-center gap-1">
            <legend className="mb-1 text-sm font-medium">
              {mine ? 'Modifier mon avis' : 'Mon avis'}
            </legend>
            {[1, 2, 3, 4, 5].map((i) => (
              <button
                key={i}
                type="button"
                aria-label={`${i} étoile${i > 1 ? 's' : ''}`}
                aria-pressed={value === i}
                onClick={() => setRating(i)}
              >
                <Star
                  className={cn(
                    'size-6',
                    i <= value ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground',
                  )}
                />
              </button>
            ))}
          </fieldset>
          <Field label="Commentaire (facultatif)">
            {(p) => (
              <Textarea
                {...p}
                maxLength={500}
                value={comment ?? mine?.comment ?? ''}
                onChange={(e) => setComment(e.target.value)}
              />
            )}
          </Field>
          {save.error ? <Alert>{save.error.message}</Alert> : null}
          {save.isSuccess ? (
            <Alert variant="success">Merci ! Votre avis sera publié après modération.</Alert>
          ) : null}
          <div>
            <Button type="submit" disabled={value < 1 || save.isPending}>
              Envoyer mon avis
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
