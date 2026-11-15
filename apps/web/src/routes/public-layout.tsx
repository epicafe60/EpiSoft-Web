import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useBranding } from '@/lib/branding';
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
  const b = useBranding();
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <div className="flex justify-end p-3">
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center gap-1">
            <img
              src={b.logoUrl}
              alt={b.associationName}
              className="h-24 w-auto dark:brightness-0 dark:invert"
            />
            <p className="text-sm font-medium text-muted-foreground">{b.appName}</p>
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
