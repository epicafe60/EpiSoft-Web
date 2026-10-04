import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { IMPORT_FIELDS, hasAnyRole, type ImportKind } from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table } from '@/components/ui/card';
import { Alert, Checkbox, Field, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { QueryError } from '../errors';
import { PageHeader } from '../shell';

interface PlanRow {
  line: number;
  label: string;
  action: 'create' | 'update' | 'unchanged' | 'error';
  changes: Record<string, { from: string | null; to: string | null }>;
  error?: string;
}
interface Preview {
  fileName: string;
  headers: string[];
  mapping: Record<string, number>;
  counts: Record<'create' | 'update' | 'unchanged' | 'error', number>;
  unknownSuppliers: string[];
  rows: PlanRow[];
}
interface HistoryRow {
  id: string;
  kind: string;
  fileName: string;
  createdAt: string;
  summary: Record<string, unknown>;
}

const ACTION_LABELS = {
  create: 'Création',
  update: 'Mise à jour',
  unchanged: 'Inchangé',
  error: 'Erreur',
} as const;

const CHANGE_LABELS: Record<string, string> = {
  purchasePrice: "Prix d'achat HT",
  salePrice: 'Prix de vente',
  stock: 'Stock',
  email: 'Courriel',
  phone: 'Téléphone',
  balance: 'Solde cagnotte',
};

const PRODUCT_FIELD_CHOICES = [
  ['purchasePrice', "Prix d'achat"],
  ['salePrice', 'Prix de vente'],
  ['stock', 'Stock (mouvement de correction)'],
] as const;

/** R-IMP-01..04 — import wizard: choose a file, preview what would change, then apply. */
export function ImportsPage() {
  const me = useMe();
  const kinds = (
    [
      ['products', 'Produits', 'PRODUITS'],
      ['members', 'Membres', 'ADHERENTS'],
    ] as const
  ).filter((k) => hasAnyRole(me.roles, [k[2]]));
  const [kind, setKind] = useState<ImportKind>(kinds[0]?.[0] ?? 'products');
  const [profile, setProfile] = useState<'epicerio' | 'custom'>('epicerio');
  const [file, setFile] = useState<File | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [supplierMap, setSupplierMap] = useState<Record<string, string>>({});
  const [confirmBalance, setConfirmBalance] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<Record<string, number> | null>(null);

  const suppliers = useQuery({
    queryKey: ['catalog-refs'],
    queryFn: () => api.get<{ suppliers: { id: string; name: string }[] }>('/catalog/refs'),
    enabled: kind === 'products' && hasAnyRole(me.roles, ['PRODUITS']),
  });
  const history = useQuery({
    queryKey: ['import-history'],
    queryFn: () => api.get<HistoryRow[]>('/imports/history'),
  });

  const qs = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      profile,
      fields: fields.join(','),
      ...(Object.keys(supplierMap).length ? { supplierMap: JSON.stringify(supplierMap) } : {}),
      confirmBalance: String(confirmBalance),
      ...extra,
    });
  const run = useMutation({
    mutationFn: async (action: 'preview' | 'apply') => {
      const path = `/imports/${kind}/${action}?${qs()}`;
      return action === 'preview'
        ? { action, data: await api.postFile<Preview>(path, file!) }
        : { action, data: await api.postFile<Record<string, number>>(path, file!) };
    },
    onSuccess: async (r) => {
      if (r.action === 'preview') {
        setPreview(r.data as Preview);
        setDone(null);
      } else {
        setDone(r.data as Record<string, number>);
        setPreview(null);
        await history.refetch();
      }
    },
  });

  const reset = () => {
    setPreview(null);
    setDone(null);
  };
  const changed = preview && preview.counts.create + preview.counts.update > 0;
  const columnList = IMPORT_FIELDS[kind].map((f) => f.label).join(', ');

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Imports"
        description="Importez un fichier CSV ou Excel : un aperçu des changements précède toujours l'application. Rejouer un fichier ne crée aucun doublon."
      />
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Données à importer">
              {(p) => (
                <Select
                  {...p}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as ImportKind);
                    reset();
                  }}
                >
                  {kinds.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Format du fichier"
              hint={
                profile === 'custom'
                  ? `Première ligne = en-têtes, reconnus automatiquement (${columnList}).`
                  : 'Export Epicerio, colonnes à leur position habituelle.'
              }
            >
              {(p) => (
                <Select
                  {...p}
                  value={profile}
                  onChange={(e) => {
                    setProfile(e.target.value as typeof profile);
                    reset();
                  }}
                >
                  <option value="epicerio">Export Epicerio</option>
                  <option value="custom">Fichier libre (en-têtes)</option>
                </Select>
              )}
            </Field>
            <Field label="Fichier (.csv ou .xlsx)">
              {(p) => (
                <input
                  {...p}
                  type="file"
                  accept=".csv,.txt,.xlsx"
                  className="text-sm"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    reset();
                  }}
                />
              )}
            </Field>
            <Button onClick={() => run.mutate('preview')} disabled={!file || run.isPending}>
              <Upload /> Aperçu
            </Button>
          </div>

          {kind === 'products' ? (
            <fieldset className="grid gap-1">
              <legend className="text-sm font-medium">
                Champs à mettre à jour sur les produits existants
              </legend>
              <div className="flex flex-wrap gap-4">
                {PRODUCT_FIELD_CHOICES.map(([k, l]) => (
                  <div key={k} className="flex items-center gap-2">
                    <Checkbox
                      id={`f-${k}`}
                      checked={fields.includes(k)}
                      onChange={(e) =>
                        setFields(e.target.checked ? [...fields, k] : fields.filter((x) => x !== k))
                      }
                    />
                    <Label htmlFor={`f-${k}`} className="font-normal">
                      {l}
                    </Label>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Les nouveaux produits sont toujours créés. Le stock importé crée un mouvement de
                correction, il n'écrase jamais l'historique.
              </p>
            </fieldset>
          ) : (
            <div className="flex items-center gap-2">
              <Checkbox
                id="confirm-balance"
                checked={confirmBalance}
                onChange={(e) => setConfirmBalance(e.target.checked)}
              />
              <Label htmlFor="confirm-balance" className="font-normal">
                Corriger la cagnotte quand le solde du fichier diffère (opération de correction de
                l'écart, jamais une addition)
              </Label>
            </div>
          )}
          {run.error ? <Alert>{run.error.message}</Alert> : null}
        </CardContent>
      </Card>

      {done ? (
        <Alert variant="success">
          Import terminé : {done.created} créé(s), {done.updated} mis à jour, {done.unchanged}{' '}
          inchangé(s), {done.errors} erreur(s)
          {done.stockCorrections ? `, ${done.stockCorrections} correction(s) de stock` : ''}
          {done.balanceCorrections ? `, ${done.balanceCorrections} correction(s) de solde` : ''}.
        </Alert>
      ) : null}

      {preview ? (
        <Card>
          <CardHeader>
            <CardTitle>Aperçu de {preview.fileName}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="flex flex-wrap gap-2 text-sm">
              <Badge>{preview.counts.create} à créer</Badge>
              <Badge>{preview.counts.update} à mettre à jour</Badge>
              <Badge variant="muted">{preview.counts.unchanged} inchangés</Badge>
              {preview.counts.error ? (
                <Badge variant="destructive">{preview.counts.error} erreurs</Badge>
              ) : null}
            </p>
            {preview.unknownSuppliers.length ? (
              <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm">
                <p className="font-medium">
                  Fournisseurs inconnus : associez-les (mémorisé pour les prochains imports).
                </p>
                {preview.unknownSuppliers.map((n) => (
                  <div key={n} className="flex flex-wrap items-center gap-2">
                    <span className="w-56 truncate">{n}</span>
                    <Select
                      aria-label={`Fournisseur pour ${n}`}
                      className="w-64"
                      value={supplierMap[n] ?? ''}
                      onChange={(e) => setSupplierMap({ ...supplierMap, [n]: e.target.value })}
                    >
                      <option value="">Aucun fournisseur</option>
                      {suppliers.data?.suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <th className="w-12">Ligne</th>
                    <th>Élément</th>
                    <th>Action</th>
                    <th>Changements</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="tabular-nums text-muted-foreground">{r.line}</td>
                      <td>{r.label}</td>
                      <td>{ACTION_LABELS[r.action]}</td>
                      <td className="text-sm">
                        {r.error ? (
                          <span className="text-destructive">{r.error}</span>
                        ) : (
                          Object.entries(r.changes).map(([k, c]) => (
                            <div key={k}>
                              {CHANGE_LABELS[k] ?? k} : {c.from ?? '—'} →{' '}
                              <strong>{c.to ?? '—'}</strong>
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                  {preview.rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-muted-foreground">
                        Rien à importer : tout est déjà à jour.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </Table>
            </div>
            <div>
              <Button onClick={() => run.mutate('apply')} disabled={!changed || run.isPending}>
                Appliquer l'import
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Historique des imports</CardTitle>
        </CardHeader>
        <CardContent>
          {history.error ? <QueryError error={history.error} /> : null}
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Fichier</th>
                <th>Résultat</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map((h) => (
                <tr key={h.id}>
                  <td>{formatDate(h.createdAt)}</td>
                  <td>{h.kind === 'products' ? 'Produits' : 'Membres'}</td>
                  <td>{h.fileName}</td>
                  <td className="text-sm text-muted-foreground">
                    {Number(h.summary.created ?? 0)} créé(s), {Number(h.summary.updated ?? 0)} mis à
                    jour
                  </td>
                </tr>
              ))}
              {history.data?.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-muted-foreground">
                    Aucun import pour l'instant.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
