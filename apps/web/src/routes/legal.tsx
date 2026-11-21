import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { LegalSection } from '@episoft/shared';
import { api } from '@/lib/api';
import { useBranding } from '@/lib/branding';
import { ThemeToggle } from '@/components/theme-toggle';
import { QueryError } from './errors';

interface LegalPage {
  associationName: string;
  mentions: LegalSection[];
  privacy: LegalSection[];
  updatedAt: string | null;
}

/** The two links to show on the sign-in page, in the footer and in the member area. */
export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="Informations légales" className={`flex flex-wrap gap-4 text-xs ${className}`}>
      <Link to="/mentions-legales" className="text-muted-foreground underline">
        Mentions légales
      </Link>
      <Link to="/confidentialite" className="text-muted-foreground underline">
        Politique de confidentialité
      </Link>
    </nav>
  );
}

function Page({ kind }: { kind: 'mentions' | 'privacy' }) {
  const b = useBranding();
  const { data, error } = useQuery({
    queryKey: ['legal'],
    queryFn: () => api.get<LegalPage>('/legal'),
  });
  const title = kind === 'mentions' ? 'Mentions légales' : 'Politique de confidentialité';
  return (
    <div className="min-h-dvh bg-muted/40">
      <div className="flex justify-between p-3">
        <Link to="/" className="text-sm text-primary hover:underline">
          ← {b.appName}
        </Link>
        <ThemeToggle />
      </div>
      <main className="mx-auto max-w-3xl px-4 pb-16">
        <h1 className="mb-1 text-2xl font-semibold">{title}</h1>
        {data ? (
          <p className="mb-6 text-sm text-muted-foreground">
            {data.associationName}
            {data.updatedAt
              ? ` · texte mis à jour le ${new Date(data.updatedAt).toLocaleDateString('fr-FR')}`
              : ''}
          </p>
        ) : null}
        {error ? <QueryError error={error} /> : null}
        {data
          ? data[kind].map((s) => (
              <section key={s.title} className="mb-6">
                <h2 className="mb-2 text-lg font-medium">{s.title}</h2>
                {s.paragraphs.map((p, i) => (
                  <p key={i} className="mb-2 text-sm">
                    {p}
                  </p>
                ))}
              </section>
            ))
          : null}
        <LegalLinks className="mt-8" />
      </main>
    </div>
  );
}

export const LegalMentionsPage = () => <Page kind="mentions" />;
export const PrivacyPage = () => <Page kind="privacy" />;
