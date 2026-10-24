import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * Modal built on the native <dialog>: focus trap, Échap to close and the backdrop come
 * from the browser (RGAA). Rendered only while open.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Two dialogs can be open at once (a confirmation over a form): each needs its own title id.
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself) closes it.
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby={titleId}
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/50',
        className,
      )}
    >
      <div className="grid gap-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Fermer"
            onClick={onClose}
            className="-mr-2 -mt-2"
          >
            <X />
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
