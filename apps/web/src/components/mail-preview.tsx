import { useState } from 'react';
import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PreviewFile {
  filename: string;
  contentType?: string;
  sizeBytes?: number;
  /** Where to open it, when it exists already (an e-mail of the journal). */
  href?: string;
}

export interface MailPreviewProps {
  from: string;
  to: string;
  subject: string;
  /** The text version, always shown. */
  text: string;
  /** The HTML version when there is one: shown as the e-mail will look, in a sandboxed frame. */
  html?: string | null;
  attachments: PreviewFile[];
  /** Under the header: when it was written, its state… */
  note?: string;
}

const size = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;

/**
 * « Aperçu » of an e-mail: the header lines (De, À, Objet, Pièces jointes) then the body, as the
 * recipient sees it (HTML, in a frame that cannot run anything) or as plain text.
 */
export function MailPreview({
  from,
  to,
  subject,
  text,
  html,
  attachments,
  note,
}: MailPreviewProps) {
  const [view, setView] = useState<'html' | 'text'>(html ? 'html' : 'text');
  return (
    <div className="grid gap-3 text-sm" aria-label="Aperçu du courriel">
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 rounded-md border bg-muted/40 p-3">
        <dt className="text-muted-foreground">De</dt>
        <dd className="break-words font-medium">{from || '—'}</dd>
        <dt className="text-muted-foreground">À</dt>
        <dd className="break-words font-medium">{to || '—'}</dd>
        <dt className="text-muted-foreground">Objet</dt>
        <dd className="break-words font-medium">{subject || '—'}</dd>
        <dt className="text-muted-foreground">Pièces jointes</dt>
        <dd>
          {attachments.length ? (
            <ul className="grid gap-1">
              {attachments.map((a, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  {a.href ? (
                    <a
                      href={a.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {a.filename}
                    </a>
                  ) : (
                    <span>{a.filename}</span>
                  )}
                  {a.sizeBytes !== undefined ? (
                    <span className="text-xs text-muted-foreground">({size(a.sizeBytes)})</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">Aucune</span>
          )}
        </dd>
      </dl>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {html ? (
        <div role="group" aria-label="Affichage du message" className="flex gap-2">
          {(['html', 'text'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                view === v ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
              {v === 'html' ? 'Mise en forme' : 'Texte brut'}
            </button>
          ))}
        </div>
      ) : null}
      {html && view === 'html' ? (
        // No scripts, no links followed, no access to the application: only the look of the mail.
        <iframe
          title="Corps du message"
          sandbox=""
          srcDoc={html}
          className="h-64 w-full rounded-md border bg-white"
        />
      ) : (
        <pre
          aria-label="Corps du message"
          className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 font-sans"
        >
          {text || '(message vide)'}
        </pre>
      )}
    </div>
  );
}
