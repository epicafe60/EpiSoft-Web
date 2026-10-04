import { useState } from 'react';
import { diffJson, inlineDiff, type DiffRow } from '@episoft/shared';
import { cn } from '@/lib/utils';

/** The value with its differing part highlighted, as in a code review. */
function Value({
  text,
  other,
  tone,
}: {
  text: string;
  other: string | undefined;
  tone: 'old' | 'new';
}) {
  if (other === undefined) return <>{text}</>;
  const d = inlineDiff(tone === 'old' ? text : other, tone === 'old' ? other : text);
  const mid = tone === 'old' ? d.oldMid : d.newMid;
  return (
    <>
      {d.prefix}
      {mid ? (
        <mark
          className={cn('rounded-sm px-px', tone === 'old' ? 'bg-destructive/30' : 'bg-success/30')}
        >
          {mid}
        </mark>
      ) : null}
      {d.suffix}
    </>
  );
}

function Line({
  sign,
  path,
  children,
  tone,
}: {
  sign: '+' | '−' | ' ';
  path: string;
  children: React.ReactNode;
  tone?: 'old' | 'new';
}) {
  return (
    <div
      className={cn(
        'flex gap-2 px-2 py-0.5',
        tone === 'old' && 'bg-destructive/10 text-foreground',
        tone === 'new' && 'bg-success/10 text-foreground',
        !tone && 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'w-3 shrink-0 select-none',
          tone === 'old' && 'text-destructive',
          tone === 'new' && 'text-success',
        )}
      >
        {sign}
      </span>
      <span className="shrink-0 font-semibold">{path || '(valeur)'}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

/**
 * The change of an audit entry as a unified comparison: removed lines in red, added lines in
 * green, the exact characters that differ highlighted, unchanged fields folded away.
 */
export function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  const [showSame, setShowSame] = useState(false);
  if (before == null && after == null) return <span className="text-muted-foreground">—</span>;
  const rows = diffJson(before, after);
  const changed = rows.filter((r) => r.kind !== 'same');
  const same = rows.filter((r) => r.kind === 'same');
  const added = changed.filter((r) => r.kind === 'added').length;
  const removed = changed.filter((r) => r.kind === 'removed').length;
  const modified = changed.filter((r) => r.kind === 'changed').length;
  const summary = [
    modified ? `${modified} modifié${modified > 1 ? 's' : ''}` : '',
    added ? `${added} ajouté${added > 1 ? 's' : ''}` : '',
    removed ? `${removed} supprimé${removed > 1 ? 's' : ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const show = (r: DiffRow) =>
    r.kind === 'changed' ? (
      <div key={r.path}>
        <Line sign="−" path={r.path} tone="old">
          <Value text={r.before!} other={r.after} tone="old" />
        </Line>
        <Line sign="+" path={r.path} tone="new">
          <Value text={r.after!} other={r.before} tone="new" />
        </Line>
      </div>
    ) : r.kind === 'added' ? (
      <Line key={r.path} sign="+" path={r.path} tone="new">
        {r.after}
      </Line>
    ) : r.kind === 'removed' ? (
      <Line key={r.path} sign="−" path={r.path} tone="old">
        {r.before}
      </Line>
    ) : (
      <Line key={r.path} sign=" " path={r.path}>
        {r.before}
      </Line>
    );

  return (
    <details>
      <summary className="cursor-pointer text-xs text-primary">
        Détail{summary ? ` · ${summary}` : changed.length === 0 ? ' · aucune différence' : ''}
      </summary>
      <div
        className="mt-2 overflow-x-auto rounded-md border font-mono text-xs"
        role="group"
        aria-label="Comparaison avant / après"
      >
        {changed.map(show)}
        {changed.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground">Aucune différence.</p>
        ) : null}
        {same.length ? (
          <>
            <button
              type="button"
              className="block w-full border-t bg-muted/50 px-2 py-1 text-left text-muted-foreground hover:text-foreground"
              onClick={() => setShowSame(!showSame)}
            >
              {showSame ? 'Masquer' : 'Afficher'} {same.length} champ{same.length > 1 ? 's' : ''}{' '}
              inchangé{same.length > 1 ? 's' : ''}
            </button>
            {showSame ? same.map(show) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
