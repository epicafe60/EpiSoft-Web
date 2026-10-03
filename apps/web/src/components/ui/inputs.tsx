import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const base =
  'w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive';

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(base, 'h-10 py-2', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(base, 'min-h-20 py-2', className)} {...props} />;
}
