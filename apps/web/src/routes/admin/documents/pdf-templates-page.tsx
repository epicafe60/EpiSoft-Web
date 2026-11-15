import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  PDF_LIMITS,
  type PdfTemplateConfig,
  type PdfTemplateDetail,
  type PdfTemplateRow,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { confirmNow } from '@/components/confirm';
import { Alert, Checkbox, Field, Input } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent } from '@/components/ui/card';
import { QueryError } from '../../errors';
import { RichEditor } from '../email/rich-editor';

const problemsOf = (e: unknown): string[] =>
  e instanceof ApiError
    ? e.problem.errors?.length
      ? e.problem.errors.map((x) => x.message)
      : [e.message]
    : e instanceof Error
      ? [e.message]
      : [];

/** Administration › Documents PDF: the wording and the columns of the PDF the application makes. */
export function PdfTemplatesPage() {
  const list = useQuery({
    queryKey: ['pdf-templates'],
    queryFn: () => api.get<PdfTemplateRow[]>('/pdf-templates'),
  });
  const [key, setKey] = useState<string | null>(null);
  if (list.error) return <QueryError error={list.error} />;
  const rows = list.data ?? [];
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Le texte des documents PDF (en-tête, fournisseur, bas de page…) et les colonnes de leurs
        tableaux. Les mots entre accolades, comme <code>{'{{numero}}'}</code>, sont remplacés au
        moment de faire le PDF. L’aperçu montre le document avec des valeurs d’exemple.
      </p>
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Liste des documents" className="grid content-start gap-0.5">
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setKey(r.key)}
              aria-current={key === r.key ? 'true' : undefined}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
                key === r.key && 'bg-accent font-medium',
              )}
            >
              <span>{r.label}</span>
              {r.customized ? <Badge>modifié</Badge> : null}
            </button>
          ))}
        </nav>
        <div>
          {key ? (
            <PdfEditor key={key} docKey={key} />
          ) : (
            <Card>
              <CardContent className="pt-5 text-sm text-muted-foreground">
                Choisissez un document dans la liste pour modifier ses textes et son tableau.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function PdfEditor({ docKey }: { docKey: string }) {
  const queryClient = useQueryClient();
  // Kept here: the form below starts again from the saved template after each save.
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['pdf-template', docKey],
    queryFn: () => api.get<PdfTemplateDetail>(`/pdf-templates/${docKey}`),
  });
  if (detail.error) return <QueryError error={detail.error} />;
  if (!detail.data) return <p className="text-muted-foreground">Chargement…</p>;
  return (
    <PdfForm
      key={`${detail.data.key}-${detail.data.updatedAt ?? 'origin'}`}
      detail={detail.data}
      notice={notice}
      onChanged={(message) => {
        setNotice(message);
        void queryClient.invalidateQueries({ queryKey: ['pdf-templates'] });
        void queryClient.invalidateQueries({ queryKey: ['pdf-template', docKey] });
      }}
    />
  );
}

interface ColumnRow {
  key: string;
  label: string;
  shown: boolean;
}

/** All the columns the document knows: the ones shown first, in their order, then the others. */
function columnRows(detail: PdfTemplateDetail): ColumnRow[] {
  const shown = detail.config.columns.map((c) => ({ key: c.key, label: c.label, shown: true }));
  const rest = detail.columns
    .filter((c) => !shown.some((s) => s.key === c.key))
    .map((c) => ({ key: c.key, label: c.label, shown: false }));
  return [...shown, ...rest];
}

function PdfForm({
  detail,
  notice,
  onChanged,
}: {
  detail: PdfTemplateDetail;
  notice: string | null;
  onChanged: (message: string) => void;
}) {
  const [zones, setZones] = useState(detail.config.zones);
  const [labels, setLabels] = useState(detail.config.labels);
  const [logo, setLogo] = useState(detail.config.logo);
  const [cols, setCols] = useState<ColumnRow[]>(() => columnRows(detail));

  // Same order of keys as what the server sends: the draft is compared with it as text.
  const draft: PdfTemplateConfig = useMemo(
    () => ({
      zones,
      columns: cols.filter((c) => c.shown).map((c) => ({ key: c.key, label: c.label })),
      labels,
      logo,
    }),
    [zones, labels, logo, cols],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail.config);

  // The preview follows the draft: the server draws the PDF with the samples.
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: () => api.postForFile(`/pdf-templates/${detail.key}/preview`, { config: draft }),
    onSuccess: ({ blob }) =>
      setPdfUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(blob);
      }),
  });
  const previewRef = useRef(preview.mutate);
  previewRef.current = preview.mutate;
  useEffect(() => {
    const id = setTimeout(() => previewRef.current(), 700);
    return () => clearTimeout(id);
  }, [draft]);
  useEffect(() => () => (pdfUrl ? URL.revokeObjectURL(pdfUrl) : undefined), [pdfUrl]);

  const save = useMutation({
    mutationFn: () => api.put(`/pdf-templates/${detail.key}`, draft),
    onSuccess: () => onChanged('Modèle enregistré.'),
  });
  const reset = useMutation({
    mutationFn: () => api.delete(`/pdf-templates/${detail.key}`),
    onSuccess: () => onChanged('Version d’origine rétablie.'),
  });

  const move = (from: number, by: -1 | 1) =>
    setCols((current) => {
      const to = from + by;
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    });
  const patch = (key: string, change: Partial<ColumnRow>) =>
    setCols((current) => current.map((c) => (c.key === key ? { ...c, ...change } : c)));

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="grid gap-5 pt-5">
          <div>
            <h2 className="text-lg font-semibold">{detail.label}</h2>
            <p className="text-sm text-muted-foreground">{detail.description}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {detail.updatedAt
                ? `Modifié le ${formatDateTime(detail.updatedAt)}.`
                : 'Texte d’origine de l’application.'}
            </p>
          </div>

          {detail.zones.map((z) => (
            <div key={z.key} className="grid gap-1.5">
              <span className="text-sm font-medium">{z.label}</span>
              <p className="text-xs text-muted-foreground">{z.hint}</p>
              <RichEditor
                variant="pdf"
                label={z.label}
                value={zones[z.key] ?? ''}
                onChange={(html) => setZones((current) => ({ ...current, [z.key]: html }))}
                variables={detail.variables}
                minHeight="5rem"
              />
            </div>
          ))}

          {detail.columns.length ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Colonnes du tableau</legend>
              <p className="text-xs text-muted-foreground">
                Cochez les colonnes à imprimer, changez leur en-tête et leur ordre.
              </p>
              <ul className="grid gap-1.5">
                {cols.map((c, i) => {
                  const def = detail.columns.find((d) => d.key === c.key)!;
                  return (
                    <li key={c.key} className="flex flex-wrap items-center gap-2">
                      <Checkbox
                        aria-label={`Afficher la colonne ${def.label}`}
                        checked={c.shown}
                        disabled={def.required}
                        onChange={(e) => patch(c.key, { shown: e.target.checked })}
                      />
                      <Input
                        aria-label={`En-tête de la colonne ${def.label}`}
                        className={cn('h-8 w-56', !c.shown && 'opacity-50')}
                        value={c.label}
                        maxLength={PDF_LIMITS.columnLabel}
                        onChange={(e) => patch(c.key, { label: e.target.value })}
                      />
                      {c.label !== def.label ? (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline"
                          onClick={() => patch(c.key, { label: def.label })}
                        >
                          Rétablir « {def.label} »
                        </button>
                      ) : null}
                      <span className="ml-auto flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Monter la colonne ${def.label}`}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Descendre la colonne ${def.label}`}
                          disabled={i === cols.length - 1}
                          onClick={() => move(i, 1)}
                        >
                          <ArrowDown />
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ) : null}

          {detail.labels.map((l) => (
            <Field key={l.key} label={l.label}>
              {(p) => (
                <Input
                  {...p}
                  value={labels[l.key] ?? ''}
                  maxLength={PDF_LIMITS.label}
                  onChange={(e) =>
                    setLabels((current) => ({ ...current, [l.key]: e.target.value }))
                  }
                />
              )}
            </Field>
          ))}

          {detail.logo ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={logo} onChange={(e) => setLogo(e.target.checked)} />
              Imprimer le logo en haut à droite
              <span className="text-xs text-muted-foreground">
                (l’image d’en-tête des courriels)
              </span>
            </label>
          ) : null}

          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">Variables de ce document</summary>
            <ul className="mt-2 grid gap-1">
              {detail.variables.map((v) => (
                <li key={v.name}>
                  <code>{`{{${v.name}}}`}</code> — {v.label}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Une ligne dont toutes les variables sont vides disparaît : pas de « SIREN : » tout
              seul.
            </p>
          </details>

          {save.error ? (
            <Alert>
              <ul className="grid gap-1">
                {problemsOf(save.error).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {notice && !dirty ? <Alert variant="success">{notice}</Alert> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
            {detail.customized ? (
              <Button
                variant="ghost"
                className="ml-auto text-destructive"
                onClick={async () => {
                  if (
                    await confirmNow({
                      title: 'Rétablir la version d’origine ?',
                      message:
                        'Vos textes et vos colonnes seront remplacés par ceux de l’application. Cette action est notée dans le journal.',
                      confirmLabel: 'Rétablir',
                      destructive: true,
                    })
                  )
                    reset.mutate();
                }}
              >
                Rétablir la version d’origine
              </Button>
            ) : null}
          </div>
          {dirty ? (
            <p className="text-xs text-muted-foreground">Modifications non enregistrées.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-2 pt-5">
          <h3 className="font-medium">Aperçu</h3>
          <p className="text-xs text-muted-foreground">
            Avec des valeurs d’exemple, tel que le PDF sera fait.
          </p>
          {preview.error ? (
            <Alert>
              <ul className="grid gap-1">
                {problemsOf(preview.error).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {pdfUrl ? (
            <iframe
              title="Aperçu du PDF"
              src={pdfUrl}
              className="h-[720px] w-full rounded-md border bg-white"
            />
          ) : (
            <p className="text-sm text-muted-foreground">Chargement de l’aperçu…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
