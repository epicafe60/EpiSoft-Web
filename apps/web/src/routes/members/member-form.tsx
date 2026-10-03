import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, KeyRound, QrCode, UserX } from 'lucide-react';
import {
  MEMBER_STATUS_LABELS,
  MEMBER_STATUSES,
  memberCreateSchema,
  proposeUsername,
  ROLE_LABELS,
  type MemberStatus,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import type { Commune, MemberDetail } from '@/lib/types';
import { PageHeader } from '../shell';
import { QueryError } from '../errors';
import { BadgeDialog } from './badge';
import { HouseholdPicker } from './household-picker';

interface FormState {
  lastName: string;
  firstName: string;
  street: string;
  postcode: string;
  communeId: string;
  phone: string;
  email: string;
  status: MemberStatus;
  publicVisible: boolean;
  newsletter: boolean;
  username: string;
}

const EMPTY: FormState = {
  lastName: '',
  firstName: '',
  street: '',
  postcode: '',
  communeId: '',
  phone: '',
  email: '',
  status: 'NEW',
  publicVisible: false,
  newsletter: false,
  username: '',
};

function toForm(m: MemberDetail): FormState {
  return {
    lastName: m.lastName,
    firstName: m.firstName,
    street: m.street ?? '',
    postcode: m.postcode ?? '',
    communeId: m.communeId ?? '',
    phone: m.phone ?? '',
    email: m.email ?? '',
    status: m.status,
    publicVisible: m.publicVisible,
    newsletter: m.newsletter,
    username: m.username ?? '',
  };
}

function toPayload(f: FormState) {
  return { ...f, communeId: f.communeId || null };
}

export function NewMemberPage() {
  return <MemberForm member={null} />;
}

export function EditMemberPage() {
  const { id } = useParams({ from: '/app/membres/$id' });
  const { data, error, isPending } = useQuery({
    queryKey: ['member', id],
    queryFn: () => api.get<MemberDetail>(`/members/${id}`),
  });
  if (isPending) return <p className="text-muted-foreground">Chargement…</p>;
  if (error) return <QueryError error={error} />;
  return <MemberForm key={data.updatedAt} member={data} />;
}

function MemberForm({ member }: { member: MemberDetail | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe();
  const [form, setForm] = useState<FormState>(member ? toForm(member) : EMPTY);
  const [household, setHousehold] = useState<{ id: string; label: string } | null>(null);
  const [newHousehold, setNewHousehold] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [badge, setBadge] = useState<{ token: string; number: number; name: string } | null>(null);
  const communes = useQuery({
    queryKey: ['communes'],
    queryFn: () => api.get<Commune[]>('/communes'),
    staleTime: Infinity,
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const communeChoices = useMemo(
    () => (communes.data ?? []).filter((c) => !form.postcode || c.postcode === form.postcode),
    [communes.data, form.postcode],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!member) {
        return api.post<{ id: string; number: number; householdId: string; qrToken: string }>(
          '/members',
          {
            ...toPayload(form),
            householdId: newHousehold ? null : (household?.id ?? null),
          },
        );
      }
      // R-MBR-09: only the fields that changed are sent.
      const initial = toForm(member);
      const changed = Object.fromEntries(
        (Object.keys(form) as (keyof FormState)[])
          .filter((k) => form[k] !== initial[k])
          .map((k) => [k, toPayload(form)[k]]),
      );
      if (household) changed.householdId = household.id;
      return api.patch<{ id: string }>(`/members/${member.id}`, {
        ...changed,
        updatedAt: member.updatedAt,
      });
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      await queryClient.invalidateQueries({ queryKey: ['member', res.id] });
      if (!member) {
        const created = res as { id: string; number: number; qrToken: string };
        setBadge({
          token: created.qrToken,
          number: created.number,
          name: `${form.firstName} ${form.lastName}`,
        });
      }
    },
    onError: (e) => setErrors(e instanceof ApiError ? e.fieldErrors() : {}),
  });

  const regenerate = useMutation({
    mutationFn: () => api.post<{ qrToken: string }>(`/members/${member!.id}/qr`),
    onSuccess: (r) =>
      setBadge({
        token: r.qrToken,
        number: member!.number,
        name: `${member!.firstName} ${member!.lastName}`,
      }),
  });

  const anonymize = useMutation({
    mutationFn: () => api.post(`/members/${member!.id}/anonymize`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['member', member!.id] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = memberCreateSchema.safeParse({ ...toPayload(form), householdId: null });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    if (!member && !newHousehold && !household) {
      setErrors({ householdId: 'Choisissez le foyer.' });
      return;
    }
    setErrors({});
    save.mutate();
  };

  const text = (k: keyof FormState, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label} error={errors[k]}>
      {(p) => (
        <Input
          {...p}
          {...props}
          value={form[k] as string}
          onChange={(e) => set(k, e.target.value as never)}
        />
      )}
    </Field>
  );

  return (
    <>
      <PageHeader
        title={member ? `${member.firstName} ${member.lastName}` : 'Nouveau membre'}
        description={
          member
            ? `Membre n° ${member.number} · créé le ${formatDateTime(member.createdAt)}`
            : undefined
        }
        actions={
          member?.householdId ? (
            <Link
              to="/foyers/$id"
              params={{ id: member.householdId }}
              className="text-sm text-primary hover:underline"
            >
              Voir le foyer, la cagnotte et les adhésions →
            </Link>
          ) : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <form onSubmit={submit} className="grid content-start gap-6" noValidate>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Identité et contact</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {text('lastName', 'Nom', { autoComplete: 'off' })}
                {text('firstName', 'Prénom', { autoComplete: 'off' })}
              </div>
              {text('street', 'Adresse')}
              <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
                {text('postcode', 'Code postal', { inputMode: 'numeric', maxLength: 5 })}
                <Field label="Commune" error={errors.communeId}>
                  {(p) => (
                    <Select
                      {...p}
                      value={form.communeId}
                      onChange={(e) => set('communeId', e.target.value)}
                    >
                      <option value="">—</option>
                      {communeChoices.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.postcode})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {text('phone', 'Téléphone', { type: 'tel' })}
                {text('email', 'Courriel', { type: 'email' })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Adhérent</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Statut"
                  error={errors.status}
                  hint="Les membres Inactif ou Archivé ne peuvent plus acheter (R-MBR-03)."
                >
                  {(p) => (
                    <Select
                      {...p}
                      value={form.status}
                      onChange={(e) => set('status', e.target.value as MemberStatus)}
                    >
                      {MEMBER_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {MEMBER_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field
                  label="Identifiant de connexion"
                  error={errors.username}
                  hint="Seulement pour les bénévoles qui se connectent."
                >
                  {(p) => (
                    <div className="flex gap-2">
                      <Input
                        {...p}
                        value={form.username}
                        onChange={(e) => set('username', e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          set('username', proposeUsername(form.firstName, form.lastName))
                        }
                        disabled={!form.lastName}
                      >
                        Proposer
                      </Button>
                    </div>
                  )}
                </Field>
              </div>
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="newsletter"
                    checked={form.newsletter}
                    onChange={(e) => set('newsletter', e.target.checked)}
                  />
                  <Label htmlFor="newsletter" className="font-normal">
                    Abonné à la lettre d’information
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="visible"
                    checked={form.publicVisible}
                    onChange={(e) => set('publicVisible', e.target.checked)}
                  />
                  <Label htmlFor="visible" className="font-normal">
                    Visible publiquement
                  </Label>
                </div>
              </div>
              {member?.newsletterOptInAt ? (
                <p className="text-xs text-muted-foreground">
                  Consentement donné le {formatDateTime(member.newsletterOptInAt)} (R-MBR-08).
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Foyer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {!member ? (
                <fieldset className="grid gap-2">
                  <legend className="sr-only">Foyer du membre</legend>
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      id="hh-new"
                      name="hh"
                      className="accent-primary"
                      checked={newHousehold}
                      onChange={() => setNewHousehold(true)}
                    />
                    <Label htmlFor="hh-new" className="font-normal">
                      Nouveau foyer, dont ce membre est le référent
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      id="hh-existing"
                      name="hh"
                      className="accent-primary"
                      checked={!newHousehold}
                      onChange={() => setNewHousehold(false)}
                    />
                    <Label htmlFor="hh-existing" className="font-normal">
                      Rattacher à un foyer existant
                    </Label>
                  </div>
                </fieldset>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Pour changer de foyer, choisissez le nouveau foyer :
                </p>
              )}
              {member || !newHousehold ? (
                <HouseholdPicker value={household} onChange={setHousehold} />
              ) : null}
              {errors.householdId ? (
                <p className="text-sm text-destructive">{errors.householdId}</p>
              ) : null}
            </CardContent>
          </Card>

          {save.error && !Object.keys(errors).length ? <Alert>{save.error.message}</Alert> : null}
          {save.isSuccess && member ? <Alert variant="success">Fiche enregistrée.</Alert> : null}
          <div className="flex gap-3">
            <Button type="submit" disabled={save.isPending}>
              {member ? 'Enregistrer' : 'Créer le membre'}
            </Button>
            <Link
              to="/membres"
              className="inline-flex h-10 items-center px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              Retour à la liste
            </Link>
          </div>
        </form>

        {member ? (
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Accès</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                <div className="flex flex-wrap gap-1">
                  {member.roles.length ? (
                    member.roles.map((r) => <Badge key={r}>{ROLE_LABELS[r]}</Badge>)
                  ) : (
                    <span className="text-muted-foreground">Aucun rôle</span>
                  )}
                </div>
                <p className="text-muted-foreground">
                  {member.hasPassword ? 'Mot de passe défini.' : 'Pas de mot de passe.'} Les rôles
                  se gèrent dans Administration.
                </p>
                <Button
                  variant="outline"
                  onClick={() => regenerate.mutate()}
                  disabled={regenerate.isPending}
                >
                  <QrCode /> {member.hasQr ? 'Nouveau badge' : 'Créer un badge'}
                </Button>
                <a
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-input px-4 text-sm font-medium hover:bg-accent"
                  href={`/api/v1/members/${member.id}/export`}
                >
                  <Download className="size-4" /> Exporter ses données (RGPD)
                </a>
                {me.roles.includes('ADMIN') && member.status !== 'ARCHIVED' ? (
                  <Button
                    variant="outline"
                    className="text-destructive"
                    onClick={() => {
                      if (
                        window.confirm(
                          'Anonymiser ce membre ? Son nom et ses coordonnées seront effacés définitivement ; les montants sont conservés.',
                        )
                      )
                        anonymize.mutate();
                    }}
                  >
                    <UserX /> Archiver et anonymiser
                  </Button>
                ) : null}
                {regenerate.error || anonymize.error ? (
                  <Alert>{(regenerate.error ?? anonymize.error)!.message}</Alert>
                ) : null}
                {!member.hasPassword && member.username ? (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <KeyRound className="size-3" /> Envoyez un lien de mot de passe depuis
                    Administration › Utilisateurs.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
      <BadgeDialog
        token={badge?.token ?? null}
        name={badge?.name ?? ''}
        number={badge?.number ?? 0}
        onClose={() => {
          setBadge(null);
          if (!member && save.data && 'id' in save.data)
            void navigate({ to: '/membres/$id', params: { id: save.data.id } });
        }}
      />
    </>
  );
}
