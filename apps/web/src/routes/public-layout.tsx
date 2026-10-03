import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';

/** Centered card used by the login and password pages. */
export function PublicLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <div className="flex justify-end p-3">
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center justify-center gap-2.5">
            <img src="/favicon.svg" alt="" className="size-9" />
            <div>
              <p className="text-lg font-semibold leading-tight">EpiSoft</p>
              <p className="text-xs text-muted-foreground">Épicafé de Montjavoult</p>
            </div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
              {description ? <CardDescription>{description}</CardDescription> : null}
            </CardHeader>
            <CardContent>{children}</CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
