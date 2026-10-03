import { useDeferredValue, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Search, UserCog } from 'lucide-react';
import { ROLE_LABELS, type UserSummary } from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe, writeCachedMe } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Input } from '@/components/ui/form';

/** Leaves impersonation. A full reload drops every cached screen of the impersonated user. */
export async function stopImpersonation() {
  await api.post('/auth/impersonate/stop');
  writeCachedMe(null);
  window.location.assign('/');
}

/** Admin menu entry: pick the user to act as, or go back to one's own account. */
export function ImpersonateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const acting = !!me.impersonator;
  const { data, error } = useQuery({
    queryKey: ['impersonation-candidates', query],
    queryFn: () =>
      api.get<UserSummary[]>(
        `/admin/users?${new URLSearchParams({ q: query, withRoles: 'false' })}`,
      ),
    enabled: open && !acting,
    placeholderData: (prev) => prev,
  });
  const start = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/impersonate`),
    onSuccess: () => {
      writeCachedMe(null);
      window.location.assign('/');
    },
  });
  const stop = useMutation({ mutationFn: stopImpersonation });
  const candidates = (data ?? []).filter((u) => u.username && !u.roles.includes('ADMIN'));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Usurper un utilisateur"
      description="Vous aurez ses droits et ses écrans. Vos actions sont journalisées à votre nom."
    >
      {acting ? (
        <div className="grid gap-3 text-sm">
          <p>
            Vous agissez actuellement en tant que{' '}
            <strong>
              {me.firstName} {me.lastName}
            </strong>
            .
          </p>
          {stop.error ? <Alert>{stop.error.message}</Alert> : null}
          <Button onClick={() => stop.mutate()} disabled={stop.isPending}>
            Revenir à mon compte
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Rechercher un utilisateur"
              placeholder="Nom, prénom ou identifiant"
              className="pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </div>
          {error ? <Alert>{error.message}</Alert> : null}
          {start.error ? <Alert>{start.error.message}</Alert> : null}
          <ul className="grid max-h-80 gap-1 overflow-y-auto" aria-label="Utilisateurs">
            {candidates.map((u) => (
              <li key={u.id} className="flex items-center gap-3 rounded-md border p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {u.firstName} {u.lastName}{' '}
                    <span className="font-normal text-muted-foreground">({u.username})</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {u.roles.map((r) => ROLE_LABELS[r]).join(', ') || 'Aucun rôle'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={start.isPending}
                  onClick={() => start.mutate(u.id)}
                >
                  <UserCog /> Usurper
                </Button>
              </li>
            ))}
            {data && candidates.length === 0 ? (
              <li className="text-sm text-muted-foreground">Aucun utilisateur trouvé.</li>
            ) : null}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
