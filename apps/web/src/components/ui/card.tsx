import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-lg font-semibold leading-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

export function Badge({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'span'> & { variant?: 'default' | 'muted' | 'success' | 'destructive' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        variant === 'default' && 'bg-secondary text-secondary-foreground',
        variant === 'muted' && 'bg-muted text-muted-foreground',
        variant === 'success' && 'bg-success/15 text-success',
        variant === 'destructive' && 'bg-destructive/15 text-destructive',
        className,
      )}
      {...props}
    />
  );
}

/** Responsive table wrapper: scrolls horizontally inside the card, never the page. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn(
          'w-full text-sm [&_th]:h-10 [&_th]:px-3 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:px-3 [&_td]:py-2.5 [&_tbody_tr]:border-t [&_tbody_tr:hover]:bg-muted/50',
          className,
        )}
        {...props}
      />
    </div>
  );
}
