import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingKey, Settings } from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { QueryError } from '../errors';

const settingsQuery = { queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') };

/** One card per setting key, saved independently (R-ADM-01). */
function SettingCard<K extends SettingKey>({
  settingKey,
  title,
  description,
  initial,
  children,
}: {
  settingKey: K;
  title: string;
  description?: string;
  initial: Settings[K];
  children: (
    value: Settings[K],
    set: (v: Settings[K]) => void,
    errors: Record<string, string>,
  ) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const save = useMutation({
    mutationFn: (v: Settings[K]) => api.put<Settings[K]>(`/settings/${settingKey}`, v),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(value);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          {children(value, setValue, errors)}
          {save.isError && !Object.keys(errors).length ? <Alert>{save.error.message}</Alert> : null}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!dirty || save.isPending}>
              Enregistrer
            </Button>
            {save.isSuccess && !dirty ? (
              <span role="status" className="text-sm text-success">
                Enregistré.
              </span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const text = (v: string | null) => v ?? '';

export function SettingsPage() {
  const { data, error, isPending } = useQuery(settingsQuery);
  if (isPending) return <p className="text-muted-foreground">Chargement…</p>;
  if (error) return <QueryError error={error} />;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SettingCard
        settingKey="association.identity"
        title="Identité de l’association"
        initial={data['association.identity']}
      >
        {(v, set, errors) => {
          const input = (key: keyof typeof v, label: string, extra: object = {}) => (
            <Field label={label} error={errors[key]}>
              {(p) => (
                <Input
                  {...p}
                  {...extra}
                  value={text(v[key])}
                  onChange={(e) => set({ ...v, [key]: e.target.value })}
                />
              )}
            </Field>
          );
          return (
            <>
              {input('name', 'Nom')}
              {input('street', 'Adresse')}
              <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
                {input('postcode', 'Code postal', { inputMode: 'numeric' })}
                {input('city', 'Commune')}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {input('siren', 'SIREN', { inputMode: 'numeric' })}
                {input('rna', 'RNA')}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {input('email', 'Courriel', { type: 'email' })}
                {input('phone', 'Téléphone', { type: 'tel' })}
              </div>
            </>
          );
        }}
      </SettingCard>

      <div className="grid content-start gap-6">
        <SettingCard
          settingKey="pos.defaultFloat"
          title="Fond de caisse par défaut"
          description="Proposé à l’ouverture d’une session de caisse."
          initial={data['pos.defaultFloat']}
        >
          {(v, set, errors) => (
            <Field label="Montant (€)" error={errors.amount} hint="Virgule ou point acceptés.">
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  className="max-w-40"
                  value={v.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                />
              )}
            </Field>
          )}
        </SettingCard>

        <SettingCard
          settingKey="wallet.overdraftLimit"
          title="Découvert autorisé sur la cagnotte"
          description="Question ouverte Q4 : 0 € par défaut tant que le bureau n’a pas tranché."
          initial={data['wallet.overdraftLimit']}
        >
          {(v, set, errors) => (
            <Field label="Montant maximal (€)" error={errors.amount}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  className="max-w-40"
                  value={v.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                />
              )}
            </Field>
          )}
        </SettingCard>

        <SettingCard
          settingKey="pos.sellToNonMembers"
          title="Vente aux non-adhérents"
          initial={data['pos.sellToNonMembers']}
        >
          {(v, set) => (
            <div className="flex items-center gap-2">
              <Checkbox
                id="sell-non-members"
                checked={v.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              <Label htmlFor="sell-non-members">Autoriser les ventes sans adhérent en caisse</Label>
            </div>
          )}
        </SettingCard>
      </div>
    </div>
  );
}
