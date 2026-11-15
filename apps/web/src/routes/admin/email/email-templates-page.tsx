import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Upload } from 'lucide-react';
import {
  EMAIL_ASSET_PATH,
  EMAIL_LIMITS,
  type EmailAssetInfo,
  type EmailLayout,
  type EmailPreview,
  type EmailTemplateDetail,
  type EmailTemplateRow,
} from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { confirmNow } from '@/components/confirm';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent } from '@/components/ui/card';
import { QueryError } from '../../errors';
import { ImagePicker, RichEditor } from './rich-editor';

const AUDIENCE_TITLES = {
  MEMBER: 'Courriels aux adhérents et clients',
  STAFF: 'Courriels à l’équipe',
} as const;

const TABS = [
  { id: 'templates', label: 'Courriels' },
  { id: 'layout', label: 'Mise en page commune' },
  { id: 'images', label: 'Images' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const problemsOf = (e: unknown): string[] =>
  e instanceof ApiError
    ? e.problem.errors?.length
      ? e.problem.errors.map((x) => x.message)
      : [e.message]
    : e instanceof Error
      ? [e.message]
      : [];

/** Administration › Courriels: the wording of every e-mail, the layout common to all, the images. */
export function EmailTemplatesPage() {
  const [tab, setTab] = useState<TabId>('templates');
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Le texte de chaque courriel envoyé par l’application. Les mots entre accolades, comme{' '}
        <code>{'{{prenom}}'}</code>, sont remplacés au moment de l’envoi. La mise en page (logo,
        en-tête, pied de page, couleur) est commune à tous les courriels.
      </p>
      <div role="tablist" aria-label="Courriels" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'templates' ? <TemplatesTab /> : null}
      {tab === 'layout' ? <LayoutTab /> : null}
      {tab === 'images' ? <ImagesTab /> : null}
    </div>
  );
}

// --- Templates ------------------------------------------------------------------------------

function TemplatesTab() {
  const list = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => api.get<EmailTemplateRow[]>('/email-templates'),
  });
  const [key, setKey] = useState<string | null>(null);
  if (list.error) return <QueryError error={list.error} />;
  const rows = list.data ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <nav aria-label="Liste des courriels" className="grid content-start gap-4">
        {(['MEMBER', 'STAFF'] as const).map((audience) => (
          <div key={audience}>
            <h2 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {AUDIENCE_TITLES[audience]}
            </h2>
            <ul className="grid gap-0.5">
              {rows
                .filter((r) => r.audience === audience)
                .map((r) => (
                  <li key={r.key}>
                    <button
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
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
      <div>
        {key ? (
          <TemplateEditor key={key} templateKey={key} />
        ) : (
          <Card>
            <CardContent className="pt-5 text-sm text-muted-foreground">
              Choisissez un courriel dans la liste pour modifier son objet et son message.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({ templateKey }: { templateKey: string }) {
  const queryClient = useQueryClient();
  // Kept here: the form below starts again from the saved wording after each save.
  const [notice, setNotice] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['email-template', templateKey],
    queryFn: () => api.get<EmailTemplateDetail>(`/email-templates/${templateKey}`),
  });
  if (detail.error) return <QueryError error={detail.error} />;
  if (!detail.data) return <p className="text-muted-foreground">Chargement…</p>;
  return (
    <TemplateForm
      key={`${detail.data.key}-${detail.data.updatedAt ?? 'origin'}`}
      detail={detail.data}
      notice={notice}
      onChanged={(message) => {
        setNotice(message);
        void queryClient.invalidateQueries({ queryKey: ['email-templates'] });
        void queryClient.invalidateQueries({ queryKey: ['email-template', templateKey] });
      }}
    />
  );
}

function TemplateForm({
  detail,
  notice,
  onChanged,
}: {
  detail: EmailTemplateDetail;
  notice: string | null;
  onChanged: (message: string) => void;
}) {
  const [subject, setSubject] = useState(detail.subject);
  const [body, setBody] = useState(detail.body);
  const [testNotice, setTestNotice] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const dirty = subject !== detail.subject || body !== detail.body;
  const textVars = detail.variables.filter((v) => v.kind === 'text');

  // The preview follows the draft: what is typed is cleaned and filled with the samples by the server.
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const previewCall = useMutation({
    mutationFn: () =>
      api.post<EmailPreview>(`/email-templates/${detail.key}/preview`, { subject, body }),
    onSuccess: setPreview,
  });
  const previewRef = useRef(previewCall.mutate);
  previewRef.current = previewCall.mutate;
  useEffect(() => {
    const id = setTimeout(() => previewRef.current(), 500);
    return () => clearTimeout(id);
  }, [subject, body]);

  const save = useMutation({
    mutationFn: () => api.put(`/email-templates/${detail.key}`, { subject, body }),
    onSuccess: () => onChanged('Courriel enregistré.'),
  });
  const test = useMutation({
    mutationFn: () => api.post(`/email-templates/${detail.key}/test`),
    onSuccess: () => setTestNotice('Un essai vient d’être mis en file d’envoi à votre adresse.'),
  });
  const reset = useMutation({
    mutationFn: () => api.delete(`/email-templates/${detail.key}`),
    onSuccess: () => onChanged('Version d’origine rétablie.'),
  });

  const insertInSubject = (name: string) => {
    const input = subjectRef.current;
    const at = input?.selectionStart ?? subject.length;
    setSubject(`${subject.slice(0, at)}{{${name}}}${subject.slice(input?.selectionEnd ?? at)}`);
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <div>
            <h2 className="text-lg font-semibold">{detail.label}</h2>
            <p className="text-sm text-muted-foreground">{detail.description}</p>
            {detail.updatedAt ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Modifié le {formatDateTime(detail.updatedAt)}.
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Texte d’origine de l’application.
              </p>
            )}
          </div>
          <Field label="Objet">
            {(p) => (
              <div className="flex gap-2">
                <Input
                  {...p}
                  ref={subjectRef}
                  value={subject}
                  maxLength={EMAIL_LIMITS.subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
                <Select
                  aria-label="Insérer une variable dans l’objet"
                  className="w-44"
                  value=""
                  onChange={(e) => e.target.value && insertInSubject(e.target.value)}
                >
                  <option value="">Variable…</option>
                  {textVars.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </Field>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Message</span>
            <RichEditor
              label="Message"
              value={body}
              onChange={setBody}
              variables={detail.variables}
            />
          </div>
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">Variables de ce courriel</summary>
            <ul className="mt-2 grid gap-1">
              {detail.variables.map((v) => (
                <li key={v.name}>
                  <code>{`{{${v.name}}}`}</code> — {v.label}
                  {v.required ? <span className="text-destructive"> (indispensable)</span> : null}
                </li>
              ))}
            </ul>
          </details>
          {preview?.problems.length ? (
            <Alert>
              <ul className="grid gap-1">
                {preview.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {save.error ? (
            <Alert>
              <ul className="grid gap-1">
                {problemsOf(save.error).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {test.error ? <Alert>{test.error.message}</Alert> : null}
          {notice && !dirty ? <Alert variant="success">{notice}</Alert> : null}
          {testNotice ? <Alert variant="success">{testNotice}</Alert> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending || dirty}
              title={dirty ? 'Enregistrez d’abord pour essayer la version modifiée' : undefined}
            >
              M’envoyer un essai
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
                        'Votre texte sera remplacé par celui de l’application. Cette action est notée dans le journal.',
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
            Avec des valeurs d’exemple, tel que le courriel sera reçu.
          </p>
          {preview ? (
            <>
              <p className="text-sm">
                <span className="text-muted-foreground">Objet : </span>
                <strong data-testid="preview-subject">{preview.subject}</strong>
              </p>
              <iframe
                title="Aperçu du courriel"
                sandbox=""
                srcDoc={preview.html}
                className="h-[560px] w-full rounded-md border bg-white"
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Chargement de l’aperçu…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Layout ---------------------------------------------------------------------------------

function LayoutTab() {
  const queryClient = useQueryClient();
  const layout = useQuery({
    queryKey: ['email-layout'],
    queryFn: () => api.get<EmailLayout>('/email-layout'),
  });
  if (layout.error) return <QueryError error={layout.error} />;
  if (!layout.data) return <p className="text-muted-foreground">Chargement…</p>;
  return (
    <LayoutForm
      initial={layout.data}
      onSaved={() => void queryClient.invalidateQueries({ queryKey: ['email-layout'] })}
    />
  );
}

function LayoutForm({ initial, onSaved }: { initial: EmailLayout; onSaved: () => void }) {
  const [draft, setDraft] = useState<EmailLayout>(initial);
  const [pick, setPick] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const previewCall = useMutation({
    mutationFn: () =>
      api.post<EmailPreview>('/email-templates/wallet_low/preview', { layout: draft }),
    onSuccess: setPreview,
  });
  const previewRef = useRef(previewCall.mutate);
  previewRef.current = previewCall.mutate;
  useEffect(() => {
    const id = setTimeout(() => previewRef.current(), 500);
    return () => clearTimeout(id);
  }, [draft]);
  const save = useMutation({
    mutationFn: () => api.put('/email-layout', draft),
    onSuccess: () => {
      setNotice('Mise en page enregistrée.');
      onSaved();
    },
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <div className="grid gap-2">
            <span className="text-sm font-medium">Image d’en-tête (logo, bandeau)</span>
            {draft.headerImageId ? (
              <img
                src={`${EMAIL_ASSET_PATH}${draft.headerImageId}`}
                alt={draft.headerAlt || 'En-tête'}
                className="max-h-32 w-full rounded border bg-muted object-contain"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucune image : le logo de l’Épicafé s’affiche, sous un trait de la couleur choisie.
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setPick(true)}>
                Choisir une image
              </Button>
              {draft.headerImageId ? (
                <Button variant="ghost" onClick={() => setDraft({ ...draft, headerImageId: null })}>
                  Retirer l’image
                </Button>
              ) : null}
            </div>
            <ImagePicker
              open={pick}
              onClose={() => setPick(false)}
              onPick={(a) => {
                setDraft({ ...draft, headerImageId: a.id });
                setPick(false);
              }}
            />
          </div>
          <Field
            label="Texte de remplacement de l’image"
            hint="Lu par les lecteurs d’écran et affiché si l’image est bloquée."
          >
            {(p) => (
              <Input
                {...p}
                value={draft.headerAlt}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, headerAlt: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Couleur principale"
            hint="Trait sous le logo (sans image d’en-tête), titres et liens."
          >
            {(p) => (
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Choisir la couleur principale"
                  className="size-9 cursor-pointer rounded border p-0"
                  value={draft.accentColor}
                  onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
                />
                <Input
                  {...p}
                  value={draft.accentColor}
                  className="w-32 font-mono"
                  maxLength={7}
                  onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })}
                />
              </div>
            )}
          </Field>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Pied de page</span>
            <RichEditor
              label="Pied de page"
              value={draft.footerHtml}
              onChange={(v) => setDraft({ ...draft, footerHtml: v })}
              minHeight="7rem"
            />
          </div>
          {save.error ? <Alert>{problemsOf(save.error).join(' ')}</Alert> : null}
          {notice && !dirty ? <Alert variant="success">{notice}</Alert> : null}
          <div>
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer la mise en page'}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-2 pt-5">
          <h3 className="font-medium">Aperçu</h3>
          {preview ? (
            <iframe
              title="Aperçu de la mise en page"
              sandbox=""
              srcDoc={preview.html}
              className="h-[560px] w-full rounded-md border bg-white"
            />
          ) : (
            <p className="text-sm text-muted-foreground">Chargement de l’aperçu…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Images ---------------------------------------------------------------------------------

function ImagesTab() {
  const queryClient = useQueryClient();
  const assets = useQuery({
    queryKey: ['email-assets'],
    queryFn: () => api.get<EmailAssetInfo[]>('/email-assets'),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['email-assets'] });
  const add = useMutation({
    mutationFn: (file: File) => {
      if (file.size > EMAIL_LIMITS.imageBytes)
        throw new Error(
          `Image trop lourde : ${Math.round(EMAIL_LIMITS.imageBytes / 1024)} Ko au plus.`,
        );
      return api.postImage('/email-assets', file);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/email-assets/${id}`),
    onSuccess: refresh,
  });
  if (assets.error) return <QueryError error={assets.error} />;
  return (
    <div className="grid gap-4">
      <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
        <Upload className="size-4" aria-hidden />
        Ajouter une image
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          aria-label="Ajouter une image"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) add.mutate(f);
            e.target.value = '';
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        PNG, JPEG, WebP ou GIF, 500 Ko au plus. Pas de SVG.
      </p>
      {add.error ? <Alert>{add.error.message}</Alert> : null}
      {remove.error ? <Alert>{remove.error.message}</Alert> : null}
      {assets.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune image pour l’instant.</p>
      ) : null}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(assets.data ?? []).map((a) => (
          <li key={a.id}>
            <Card>
              <CardContent className="grid gap-2 pt-5">
                <img
                  src={`${EMAIL_ASSET_PATH}${a.id}`}
                  alt={a.name}
                  className="h-28 w-full rounded bg-muted object-contain"
                />
                <div className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {Math.max(1, Math.round(a.bytes / 1024))} Ko · {formatDateTime(a.createdAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.usedBy.length ? `Utilisée : ${a.usedBy.join(', ')}` : 'Pas utilisée'}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Supprimer ${a.name}`}
                    disabled={a.usedBy.length > 0}
                    title={a.usedBy.length ? 'Utilisée : remplacez-la d’abord' : 'Supprimer'}
                    onClick={async () => {
                      if (
                        await confirmNow({
                          title: 'Supprimer cette image ?',
                          message: `« ${a.name} » sera supprimée de la bibliothèque.`,
                          confirmLabel: 'Supprimer',
                          destructive: true,
                        })
                      )
                        remove.mutate(a.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
