import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingKey, Settings } from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { QueryError } from '../errors';

const settingsQuery = { queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') };

const ACCOUNT_FIELDS = [
  ['sales', 'Ventes'],
  ['purchases', 'Achats'],
  ['cash', 'Caisse espèces'],
  ['cheques', 'Chèques à encaisser'],
  ['cards', 'Cartes à encaisser'],
  ['bank', 'Banque'],
  ['wallet', 'Cagnottes (dette envers les adhérents)'],
  ['memberships', 'Adhésions'],
  ['donations', 'Dons'],
  ['otherIncome', 'Autres produits'],
  ['cashShort', 'Écarts de caisse (charge)'],
  ['stock', 'Stock'],
  ['stockVariation', 'Variation de stock'],
  ['surplus', 'Résultat : excédent'],
  ['deficit', 'Résultat : déficit'],
] as const;

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
          settingKey="pos.options"
          title="Options de caisse"
          initial={data['pos.options']}
        >
          {(v, set) => (
            <div className="grid gap-2">
              {(
                [
                  ['allowTransfer', 'Accepter le virement comme règlement en caisse'],
                  ['discountsEnabled', 'Autoriser les remises sur une ligne (R-VTE-07)'],
                  [
                    'membershipExpiredBlocking',
                    'Bloquer la vente si l’adhésion est expirée (R-ADH-03)',
                  ],
                ] as const
              ).map(([k, label]) => (
                <div key={k} className="flex items-center gap-2">
                  <Checkbox
                    id={`opt-${k}`}
                    checked={v[k]}
                    onChange={(e) => set({ ...v, [k]: e.target.checked })}
                  />
                  <Label htmlFor={`opt-${k}`}>{label}</Label>
                </div>
              ))}
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="catalog.pricing"
          title="Marge cible et arrondi"
          description="Taux de marque sur le prix de vente TTC, proposé à la réception (R-PRD-03, question Q2)."
          initial={data['catalog.pricing']}
        >
          {(v, set, errors) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Taux de marque cible (%)" error={errors.targetMarkupPct}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={String(v.targetMarkupPct)}
                    onChange={(e) =>
                      set({ ...v, targetMarkupPct: Number(e.target.value.replace(',', '.')) || 0 })
                    }
                  />
                )}
              </Field>
              <Field label="Arrondi du prix">
                {(p) => (
                  <Select
                    {...p}
                    value={String(v.rounding)}
                    onChange={(e) => set({ ...v, rounding: Number(e.target.value) as 1 | 5 | 10 })}
                  >
                    <option value="1">au centime</option>
                    <option value="5">à 0,05 €</option>
                    <option value="10">à 0,10 €</option>
                  </Select>
                )}
              </Field>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="labels.layout"
          title="Planches d’étiquettes"
          initial={data['labels.layout']}
        >
          {(v, set) => (
            <Field label="Format A4">
              {(p) => (
                <Select
                  {...p}
                  value={String(v.perPage)}
                  onChange={(e) => set({ perPage: Number(e.target.value) as 24 | 40 })}
                >
                  <option value="24">24 étiquettes (3 × 8)</option>
                  <option value="40">40 étiquettes (4 × 10)</option>
                </Select>
              )}
            </Field>
          )}
        </SettingCard>

        <SettingCard
          settingKey="membership.reminder"
          title="Relance d’adhésion"
          description="Courriel au foyer avant la fin de son adhésion, une seule fois (R-ADH-04)."
          initial={data['membership.reminder']}
        >
          {(v, set, errors) => (
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="reminder-on"
                  checked={v.enabled}
                  onChange={(e) => set({ ...v, enabled: e.target.checked })}
                />
                <Label htmlFor="reminder-on">Envoyer la relance</Label>
              </div>
              <Field label="Jours avant l’échéance" error={errors.daysBefore}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    className="max-w-24"
                    value={String(v.daysBefore)}
                    onChange={(e) =>
                      set({ ...v, daysBefore: Number(e.target.value.replace(/\D/g, '')) || 0 })
                    }
                  />
                )}
              </Field>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="stock.expiryAlert"
          title="Alerte dates limites"
          description="Chaque matin, courriel et notification à l’équipe approvisionnements s’il y a des lots périmés ou proches de leur date (R-STK-07)."
          initial={data['stock.expiryAlert']}
        >
          {(v, set, errors) => (
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="expiry-on"
                  checked={v.enabled}
                  onChange={(e) => set({ ...v, enabled: e.target.checked })}
                />
                <Label htmlFor="expiry-on">Envoyer l’alerte</Label>
              </div>
              <Field label="Prévenir à l’avance (jours)" error={errors.daysBefore}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    className="max-w-24"
                    value={String(v.daysBefore)}
                    onChange={(e) =>
                      set({ ...v, daysBefore: Number(e.target.value.replace(/\D/g, '')) || 0 })
                    }
                  />
                )}
              </Field>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="wallet.lowReminder"
          title="Rappel de cagnotte basse"
          description="Courriel au foyer (et notification) quand sa cagnotte passe sous le seuil, s’il a acheté récemment ; un rappel au plus par période (R-CAG-06)."
          initial={data['wallet.lowReminder']}
        >
          {(v, set, errors) => (
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="low-on"
                  checked={v.enabled}
                  onChange={(e) => set({ ...v, enabled: e.target.checked })}
                />
                <Label htmlFor="low-on">Envoyer le rappel</Label>
              </div>
              <Field label="Seuil (€)" error={errors.threshold}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    className="max-w-28"
                    value={v.threshold}
                    onChange={(e) => set({ ...v, threshold: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Un rappel au plus tous les (jours)" error={errors.everyDays}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    className="max-w-24"
                    value={String(v.everyDays)}
                    onChange={(e) =>
                      set({ ...v, everyDays: Number(e.target.value.replace(/\D/g, '')) || 0 })
                    }
                  />
                )}
              </Field>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="pos.scaleBarcodes"
          title="Étiquettes de balance"
          description="Codes 20 à 29 : préfixe, code article (5 chiffres, fin du code produit), valeur (5 chiffres), clé (R-VTE-04)."
          initial={data['pos.scaleBarcodes']}
        >
          {(v, set) => (
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="scale-on"
                  checked={v.enabled}
                  onChange={(e) => set({ ...v, enabled: e.target.checked })}
                />
                <Label htmlFor="scale-on">Décoder les étiquettes de balance en caisse</Label>
              </div>
              <Field label="La valeur imprimée est">
                {(p) => (
                  <Select
                    {...p}
                    value={v.valueKind}
                    onChange={(e) => set({ ...v, valueKind: e.target.value as 'PRICE' | 'WEIGHT' })}
                  >
                    <option value="PRICE">le prix (centimes)</option>
                    <option value="WEIGHT">le poids (grammes)</option>
                  </Select>
                )}
              </Field>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="pos.treasurerEmail"
          title="Courriel du trésorier"
          description="Reçoit le rapport de chaque clôture de caisse (R-SES-02)."
          initial={data['pos.treasurerEmail']}
        >
          {(v, set, errors) => (
            <Field label="Courriel" error={errors.email}>
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  value={v.email ?? ''}
                  onChange={(e) => set({ email: e.target.value })}
                />
              )}
            </Field>
          )}
        </SettingCard>

        <SettingCard
          settingKey="accounting.accounts"
          title="Comptes des écritures automatiques"
          description="Comptes utilisés pour les écritures générées par les ventes, factures et clôtures (R-CPT-08..11)."
          initial={data['accounting.accounts']}
        >
          {(v, set, errors) => (
            <div className="grid gap-3 sm:grid-cols-2">
              {ACCOUNT_FIELDS.map(([key, label]) => (
                <Field key={key} label={label} error={errors[key]}>
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="numeric"
                      maxLength={6}
                      value={v[key]}
                      onChange={(e) => set({ ...v, [key]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
            </div>
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
