import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { Alert } from '@/components/ui/form';
import { Button } from '@/components/ui/button';

export function NotFound() {
  return (
    <div className="mx-auto grid max-w-md gap-4 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Page introuvable</h1>
      <p className="text-muted-foreground">Cette adresse ne correspond à aucune page.</p>
      <Link to="/" className="text-primary hover:underline">
        Revenir à l’accueil
      </Link>
    </div>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="mx-auto grid max-w-md gap-4 px-4 py-16">
      <h1 className="text-xl font-semibold">Un problème est survenu</h1>
      <Alert>{error instanceof Error ? error.message : 'Erreur inconnue.'}</Alert>
      <Button variant="outline" onClick={reset}>
        Réessayer
      </Button>
    </div>
  );
}

/** Inline error for a failed query inside a page. */
export function QueryError({ error }: { error: unknown }) {
  return <Alert>{error instanceof Error ? error.message : 'Chargement impossible.'}</Alert>;
}
