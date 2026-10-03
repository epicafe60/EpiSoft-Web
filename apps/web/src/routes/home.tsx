import { Link } from '@tanstack/react-router';
import { visibleModules } from '@episoft/shared';
import { useMe } from '@/lib/auth';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/form';
import { MODULE_ICONS, PageHeader } from './shell';
import { MODULE_INFO } from './module-placeholder';
import { Dashboard } from './dashboard';

export function HomePage() {
  const me = useMe();
  const modules = visibleModules(me.roles);
  return (
    <>
      <PageHeader title={`Bonjour ${me.firstName}`} description="Choisissez un module." />
      {modules.length > 0 ? <Dashboard /> : null}
      {modules.length === 0 ? (
        <Alert variant="info">
          Aucun rôle ne vous est attribué pour l’instant. Un administrateur peut vous en donner
          depuis Administration › Utilisateurs.
        </Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => {
            const Icon = MODULE_ICONS[m.key];
            return (
              <Link key={m.key} to={m.path} className="group rounded-lg focus-visible:outline-2">
                <Card className="h-full transition-colors group-hover:border-primary/50 group-hover:bg-accent/40">
                  <CardHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </div>
                    <CardTitle className="text-base">{m.label}</CardTitle>
                    <CardDescription>{MODULE_INFO[m.key].summary}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
