import { useEffect, useRef, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';

/**
 * A row of section links that scrolls sideways on a phone and brings the current section into
 * view, so the active tab is never hidden off-screen.
 */
export function TabNav({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const nav = ref.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    // Scroll the row only (not the page): centre the active tab inside it.
    nav.scrollTo({
      left: active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2,
      behavior: 'auto',
    });
  }, [path]);
  return (
    <nav
      ref={ref}
      aria-label={label}
      className="mb-6 flex gap-1 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </nav>
  );
}
