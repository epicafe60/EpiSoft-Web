import { useDeferredValue, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Search } from 'lucide-react';
import {
  MEMBER_STATUS_LABELS,
  ROLE_CODES,
  ROLE_LABELS,
  type RoleCode,
  type UserSummary,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge, Card, Table } from '@/components/ui/card';
import { Alert, Checkbox, Input, Label } from '@/components/ui/form';
import { SortTh, useSort, NoMatchRow } from '@/components/ui/sortable';
import { QueryError } from '../errors';

function RolesEditor({ user, onDone }: { user: UserSummary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const me = useMe();
  const [roles, setRoles] = useState<RoleCode[]>(user.roles);
  const save = useMutation({
    mutationFn: () => api.put(`/admin/users/${user.id}/roles`, { roles }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      if (user.id === me.id) await queryClient.invalidateQueries({ queryKey: ['me'] });
      onDone();
    },
  });
  const toggle = (r: RoleCode, on: boolean) =>
    setRoles(on ? [...roles, r] : roles.filter((x) => x !== r));
  return (
    <div className="grid gap-3 rounded-md bg-muted/50 p-3">
      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="sr-only">
          Rôles de {user.firstName} {user.lastName}
        </legend>
        {ROLE_CODES.map((r) => (
          <div key={r} className="flex items-center gap-2">
            <Checkbox
              id={`${user.id}-${r}`}
              checked={roles.includes(r)}
              onChange={(e) => toggle(r, e.target.checked)}
            />
            <Label htmlFor={`${user.id}-${r}`} className="font-normal">
              {ROLE_LABELS[r]}
            </Label>
          </div>
        ))}
      </fieldset>
      {save.error ? <Alert>{save.error.message}</Alert> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          Enregistrer les rôles
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </div>
  );
}

function PasswordLinkButton({ user }: { user: UserSummary }) {
  const send = useMutation({ mutationFn: () => api.post(`/admin/users/${user.id}/password-link`) });
  if (send.isSuccess) return <span className="text-xs text-success">Lien envoyé</span>;
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => send.mutate()}
      disabled={send.isPending || !user.username}
      title={
        send.error instanceof ApiError
          ? send.error.message
          : 'Envoyer par courriel un lien pour définir le mot de passe'
      }
    >
      <KeyRound /> {send.isError ? 'Échec' : 'Lien mot de passe'}
    </Button>
  );
}

const USER_SORT = {
  number: (u: UserSummary) => u.number,
  name: (u: UserSummary) => `${u.lastName} ${u.firstName}`,
  roles: (u: UserSummary) => u.roles.map((r) => ROLE_LABELS[r]).join(' '),
};

export function UsersPage() {
  const [q, setQ] = useState('');
  const [onlyWithRoles, setOnlyWithRoles] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const query = useDeferredValue(q.trim());
  const { data, error, isPending } = useQuery({
    queryKey: ['users', query, onlyWithRoles],
    queryFn: () =>
      api.get<UserSummary[]>(
        `/admin/users?${new URLSearchParams({ q: query, withRoles: String(onlyWithRoles) })}`,
      ),
    placeholderData: (prev) => prev,
  });

  const sort = useSort(data, USER_SORT);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Rechercher un membre"
            placeholder="Nom, prénom, identifiant, n°…"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="only-roles"
            checked={onlyWithRoles}
            onChange={(e) => setOnlyWithRoles(e.target.checked)}
          />
          <Label htmlFor="only-roles" className="font-normal">
            Seulement les membres ayant un rôle
          </Label>
        </div>
      </div>

      {error ? <QueryError error={error} /> : null}
      <Card>
        <Table>
          <thead>
            <tr>
              <SortTh state={sort} sortKey="number" className="w-16">
                N°
              </SortTh>
              <SortTh state={sort} sortKey="name">
                Membre
              </SortTh>
              <SortTh state={sort} sortKey="roles">
                Rôles
              </SortTh>
              <th className="w-0" />
            </tr>
          </thead>
          <tbody>
            {isPending ? (
              <tr>
                <td colSpan={4} className="text-muted-foreground">
                  Chargement…
                </td>
              </tr>
            ) : data?.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-muted-foreground">
                  Aucun membre trouvé.
                </td>
              </tr>
            ) : (
              sort.rows?.map((u) => (
                <tr key={u.id} className="align-top">
                  <td className="tabular-nums text-muted-foreground">{u.number}</td>
                  <td>
                    <div className="font-medium">
                      {u.lastName} {u.firstName}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{u.username ?? 'sans identifiant'}</span>
                      {u.status !== 'ACTIVE' ? (
                        <Badge variant="muted">{MEMBER_STATUS_LABELS[u.status]}</Badge>
                      ) : null}
                      {!u.hasPassword && u.username ? (
                        <Badge variant="muted">mot de passe à définir</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    {editing === u.id ? (
                      <RolesEditor user={u} onDone={() => setEditing(null)} />
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length ? (
                          u.roles.map((r) => <Badge key={r}>{ROLE_LABELS[r]}</Badge>)
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="flex justify-end gap-2">
                      {editing !== u.id ? (
                        <Button size="sm" variant="outline" onClick={() => setEditing(u.id)}>
                          Modifier
                        </Button>
                      ) : null}

                      <PasswordLinkButton user={u} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <NoMatchRow state={sort} total={data?.length} />
        </Table>
      </Card>
    </div>
  );
}
