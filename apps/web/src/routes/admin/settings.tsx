import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_THRESHOLDS,
  THRESHOLD_LABELS,
  VAT_REGIME_LABELS,
  VAT_REGIMES,
  type VatRegime,
  type SettingKey,
  type Settings,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, todayIso } from '@/lib/format';
import { useVatRegime } from '@/lib/vat-regime';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { useConfirm } from '@/components/confirm';
import { QueryError } from '../errors';
import { ImagePicker } from './email/rich-editor';
import { brandingLogoUrl, DEFAULT_BRANDING } from '@episoft/shared';

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
  ['vatCollected20', 'TVA collectée 20 %'],
  ['vatCollected10', 'TVA collectée 10 %'],
  ['vatCollected55', 'TVA collectée 5,5 %'],
  ['vatCollected21', 'TVA collectée 2,1 %'],
  ['vatDeductible', 'TVA déductible'],
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
      if (
        settingKey === 'app.branding' ||
        settingKey === 'association.identity' ||
        settingKey === 'app.timezone'
      )
        await queryClient.invalidateQueries({ queryKey: ['branding'] });
      // The product sheet and the list read this option with the catalogue references.
      if (settingKey === 'catalog.foodInfo')
        await queryClient.invalidateQueries({ queryKey: ['catalog-refs'] });
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);

  const confirm = useConfirm();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // The time zone decides the day of every ticket, closing and statistic: ask before changing it.
    if (
      settingKey === 'app.timezone' &&
      !(await confirm({
        title: 'Changer le fuseau horaire ?',
        message:
          'Le fuseau horaire détermine le jour de chaque ticket, de chaque clôture et de chaque statistique. Il s’applique tout de suite, pour toute la boutique.',
        impact: [
          'Les tickets déjà enregistrés ne changent pas, mais leur jour affiché peut changer.',
        ],
        confirmLabel: 'Changer le fuseau',
        destructive: true,
      }))
    )
      return;
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

/** The logo of the application: an image of the library, or the one shipped with the application. */
function LogoField({
  imageId,
  onChange,
}: {
  imageId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [pick, setPick] = useState(false);
  return (
    <div className="grid gap-2">
      <Label>Logo</Label>
      <div className="flex flex-wrap items-center gap-4">
        <img
          src={brandingLogoUrl(imageId)}
          alt="Logo actuel"
          className="h-16 w-auto max-w-48 rounded border bg-white p-1 object-contain"
        />
        <Button type="button" variant="outline" onClick={() => setPick(true)}>
          Choisir une image
        </Button>
        {imageId ? (
          <Button type="button" variant="ghost" onClick={() => onChange(null)}>
            Remettre le logo d’origine
          </Button>
        ) : null}
      </div>
      <ImagePicker
        open={pick}
        onClose={() => setPick(false)}
        title="Choisir le logo"
        description="Une image de la bibliothèque, ou une nouvelle (PNG, JPEG, WebP ou GIF, 500 Ko au plus). Le menu et la page de connexion l’affichent."
        pickVerb="Choisir"
        onPick={(a) => {
          setPick(false);
          onChange(a.id);
        }}
      />
    </div>
  );
}

/** R-TVA-07: the VAT regime, effective from a date, with its history (past operations never change). */
function VatRegimeCard() {
  const queryClient = useQueryClient();
  const info = useVatRegime();
  const [regime, setRegime] = useState<VatRegime>('LIABLE');
  const [from, setFrom] = useState(todayIso());
  const save = useMutation({
    mutationFn: () => api.post('/vat-regime', { regime, effectiveFrom: from }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vat-regime'] }),
  });
  const history = [...(info.data?.changes ?? [])].reverse();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Régime de TVA</CardTitle>
        <CardDescription>
          Assujettie : TVA par taux sur les tickets, les clôtures et les états, écritures de TVA.
          Franchise en base (art. 293 B) ou exonérée (art. 261) : aucune TVA facturée ni
          récupérable, les ventes sont comptées TTC et les factures fournisseurs en charge TTC. Un
          changement s’applique à partir d’une date et ne modifie jamais les opérations passées.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm">
          Régime actuel : <strong>{VAT_REGIME_LABELS[info.data?.current ?? 'LIABLE']}</strong>
        </p>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Nouveau régime">
            {(p) => (
              <Select
                {...p}
                value={regime}
                onChange={(e) => setRegime(e.target.value as VatRegime)}
              >
                {VAT_REGIMES.map((r) => (
                  <option key={r} value={r}>
                    {VAT_REGIME_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="À partir du">
            {(p) => (
              <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            )}
          </Field>
          <Button type="submit" disabled={save.isPending}>
            Enregistrer
          </Button>
        </form>
        {save.isError ? <Alert>{save.error.message}</Alert> : null}
        {history.length ? (
          <ul className="text-sm text-muted-foreground">
            {history.map((c) => (
              <li key={c.effectiveFrom}>
                Depuis le {formatDate(c.effectiveFrom)} : {VAT_REGIME_LABELS[c.regime]}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { data, error, isPending } = useQuery(settingsQuery);
  if (isPending) return <p className="text-muted-foreground">Chargement…</p>;
  if (error) return <QueryError error={error} />;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SettingCard
        settingKey="app.branding"
        title="Identité de l’application"
        description="Le nom du logiciel, son logo et sa couleur, pour l’association qui l’utilise : ils apparaissent partout (menu, connexion, courriels, notifications)."
        initial={data['app.branding']}
      >
        {(v, set, errors) => (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom du logiciel" error={errors.appName}>
                {(p) => (
                  <Input
                    {...p}
                    value={v.appName}
                    onChange={(e) => set({ ...v, appName: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Nom court de l’association"
                error={errors.shortName}
                hint="Début des objets de courriel : « Épicafé : ticket 12 »."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={v.shortName}
                    onChange={(e) => set({ ...v, shortName: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field
              label="Couleur principale"
              error={errors.accentColor}
              hint="Boutons et liens du thème clair, barre du navigateur. Une couleur trop claire est refusée."
            >
              {(p) => (
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    aria-label="Choisir la couleur"
                    className="h-10 w-14 cursor-pointer rounded border bg-transparent"
                    value={
                      /^#[0-9a-fA-F]{6}$/.test(v.accentColor)
                        ? v.accentColor
                        : DEFAULT_BRANDING.accentColor
                    }
                    onChange={(e) => set({ ...v, accentColor: e.target.value })}
                  />
                  <Input
                    {...p}
                    className="max-w-32 font-mono"
                    value={v.accentColor}
                    onChange={(e) => set({ ...v, accentColor: e.target.value })}
                  />
                </div>
              )}
            </Field>
            <LogoField imageId={v.logoImageId} onChange={(id) => set({ ...v, logoImageId: id })} />
          </>
        )}
      </SettingCard>

      <SettingCard
        settingKey="app.timezone"
        title="Fuseau horaire"
        description="Celui de l’épicerie : il décide du jour d’un ticket, d’une clôture, d’une statistique. Un changement s’applique tout de suite ; il ne déplace aucune opération passée."
        initial={data['app.timezone']}
      >
        {(v, set, errors) => (
          <Field
            label="Fuseau (nom IANA)"
            error={errors.timeZone}
            hint="Exemples : Europe/Paris, America/Martinique, Indian/Reunion."
          >
            {(p) => (
              <>
                <Input
                  {...p}
                  list="time-zones"
                  className="max-w-72"
                  value={v.timeZone}
                  onChange={(e) => set({ timeZone: e.target.value })}
                />
                <datalist id="time-zones">
                  {(Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
                    .supportedValuesOf?.('timeZone')
                    .map((z) => (
                      <option key={z} value={z} />
                    ))}
                </datalist>
              </>
            )}
          </Field>
        )}
      </SettingCard>

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

      <SettingCard
        settingKey="legal.texts"
        title="Mentions légales et confidentialité"
        description="Texte des pages publiques « Mentions légales » et « Politique de confidentialité » (liées depuis la page de connexion). Un champ laissé vide utilise le texte standard ; l’adresse, le SIREN, le RNA et le courriel viennent de l’identité ci-dessus."
        initial={data['legal.texts']}
      >
        {(v, set, errors) => {
          const one = (key: keyof typeof v, label: string, hint?: string) => (
            <Field label={label} error={errors[key]} {...(hint ? { hint } : {})}>
              {(p) => (
                <Input
                  {...p}
                  value={text(v[key])}
                  onChange={(e) => set({ ...v, [key]: e.target.value })}
                />
              )}
            </Field>
          );
          const area = (key: keyof typeof v, label: string) => (
            <Field
              label={label}
              error={errors[key]}
              hint="Un paragraphe par ligne. Vide : texte standard."
            >
              {(p) => (
                <textarea
                  {...p}
                  rows={4}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={text(v[key])}
                  onChange={(e) => set({ ...v, [key]: e.target.value })}
                />
              )}
            </Field>
          );
          return (
            <>
              {one('publicationDirector', 'Directeur ou directrice de la publication')}
              <div className="grid gap-4 sm:grid-cols-2">
                {one('hostName', 'Hébergeur (nom)')}
                {one('hostAddress', 'Hébergeur (adresse)')}
              </div>
              {one(
                'privacyContact',
                'Courriel pour exercer ses droits',
                'Par défaut : le courriel de l’association.',
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {one('dpoName', 'Délégué à la protection des données (si désigné)')}
                {one('dpoContact', 'Contact du délégué')}
              </div>
              {area('purposes', 'Finalités')}
              {area('legalBasis', 'Base légale')}
              {area('recipients', 'Destinataires')}
              {area('retention', 'Durées de conservation')}
              {area('rights', 'Droits des personnes')}
              {area('extra', 'Informations complémentaires (mentions légales)')}
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
                  ['discountsEnabled', 'Autoriser les remises sur une ligne'],
                  ['membershipExpiredBlocking', 'Bloquer la vente si l’adhésion est expirée'],
                  [
                    'requireMemberFirst',
                    'Imposer un adhérent (ou une adhésion de passage) avant la première ligne',
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
          description="Taux de marque sur le prix de vente TTC, proposé à la réception."
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
          settingKey="shop.enabled"
          title="Boutique en ligne"
          description="Désactivée, la boutique n’est plus accessible aux adhérents : plus de catalogue, de panier ni de commande. Les commandes déjà passées restent gérables par l’équipe."
          initial={data['shop.enabled']}
        >
          {(v, set) => (
            <div className="flex items-center gap-2">
              <Checkbox
                id="shop-on"
                checked={v.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              <Label htmlFor="shop-on">Activer la boutique en ligne</Label>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="catalog.foodInfo"
          title="Information du consommateur sur les produits alimentaires"
          description="Option. Activée, la fiche produit demande les allergènes, les ingrédients, la quantité nette et l’origine (règlement UE 1169/2011) : un produit alimentaire incomplet est refusé, n’a pas d’étiquette et n’est pas proposé en ligne, et ces informations sont imprimées sur l’étiquette et affichées dans la boutique. Désactivée, rien de cela n’est demandé ni affiché ; les informations déjà saisies sont conservées. Le lot et la date limite à la réception restent demandés."
          initial={data['catalog.foodInfo']}
        >
          {(v, set) => (
            <div className="flex items-center gap-2">
              <Checkbox
                id="food-info-on"
                checked={v.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              <Label htmlFor="food-info-on">
                Demander et afficher les allergènes et les ingrédients
              </Label>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="email.enabled"
          title="Envoi des courriels"
          description="Désactivé, aucun courriel ne part (liens de mot de passe, relances, alertes, rapports). Ils sont consignés comme non envoyés et ne partiront pas en différé à la réactivation. Les liens de mot de passe restent obtenables avec la commande d’invitation du serveur."
          initial={data['email.enabled']}
        >
          {(v, set) => (
            <div className="flex items-center gap-2">
              <Checkbox
                id="email-on"
                checked={v.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              <Label htmlFor="email-on">Activer l’envoi des courriels</Label>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="membership.reminder"
          title="Relance d’adhésion"
          description="Courriel au foyer avant la fin de son adhésion, une seule fois."
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
          description="Chaque matin, courriel et notification à l’équipe approvisionnements s’il y a des lots périmés ou proches de leur date."
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
          settingKey="controls.thresholds"
          title="Seuils d’alerte"
          description="À partir de quand l’application prévient : le caissier avant d’encaisser, les responsables dans « À surveiller ». Une alerte n’empêche jamais une vente."
          initial={data['controls.thresholds']}
        >
          {(v, set, errors) => (
            <div className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {(Object.keys(THRESHOLD_LABELS) as (keyof typeof THRESHOLD_LABELS)[]).map((k) => (
                  <Field
                    key={k}
                    label={`${THRESHOLD_LABELS[k].label} (${THRESHOLD_LABELS[k].unit})`}
                    error={errors[k]}
                  >
                    {(p) => (
                      <Input
                        {...p}
                        inputMode="decimal"
                        className="max-w-32"
                        value={String(v[k])}
                        onChange={(e) =>
                          set({ ...v, [k]: Number(e.target.value.replace(',', '.')) || 0 })
                        }
                      />
                    )}
                  </Field>
                ))}
              </div>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => set({ ...DEFAULT_THRESHOLDS })}
                >
                  Remettre les valeurs par défaut
                </Button>
              </div>
            </div>
          )}
        </SettingCard>

        <SettingCard
          settingKey="wallet.lowReminder"
          title="Rappel de cagnotte basse"
          description="Courriel au foyer (et notification) quand sa cagnotte passe sous le seuil, s’il a acheté récemment ; un rappel au plus par période."
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
          description="Codes 20 à 29 : préfixe, code article (5 chiffres, fin du code produit), valeur (5 chiffres), clé."
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
          description="Reçoit le rapport de chaque clôture de caisse."
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

        <VatRegimeCard />

        <SettingCard
          settingKey="accounting.accounts"
          title="Comptes des écritures automatiques"
          description="Comptes utilisés pour les écritures générées par les ventes, factures et clôtures."
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

        <SettingCard
          settingKey="pos.cashierSwitch"
          title="Changement de caissier"
          initial={data['pos.cashierSwitch']}
        >
          {(v, set) => (
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="cashier-pin"
                  checked={v.requirePin}
                  onChange={(e) => set({ requirePin: e.target.checked })}
                />
                <Label htmlFor="cashier-pin">Code caissier exigé (4 chiffres)</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Les caissiers se relaient sans se déconnecter : chacun touche son nom en caisse.
                Avec le code, personne ne peut encaisser au nom d’un autre ; sans code, le caissier
                est seulement déclaré, et le journal le signale « non vérifié ».
              </p>
            </div>
          )}
        </SettingCard>
      </div>
    </div>
  );
}
