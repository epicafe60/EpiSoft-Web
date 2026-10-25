import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { tableLabel, type RevertPreview } from '@episoft/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input } from '@/components/ui/form';
import { AuditDiff } from './audit-diff';

const CONFLICT_TEXT: Record<RevertPreview['conflicts'][number]['kind'], string> = {
  changed: 'modifié depuis',
  deleted: 'supprimé depuis',
  exists: 'existe de nouveau',
  secret: 'valeur non conservée (secret ou fichier)',
  nokey: 'impossible à retrouver',
};

/**
 * R-ADM-06: what « Annuler cette action » will do, then the confirmation with a reason. The
 * preview is computed by the server running the undo and rolling it back.
 */
export function RevertDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  // A conflict offers to undo the more recent action first: the dialog then follows it.
  const [current, setCurrent] = useState<string | null>(null);
  const shown = current ?? id;
  const [reason, setReason] = useState('');
  // What each undo done from this window said, by journal entry.
  const [done, setDone] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['revert-preview', shown],
    queryFn: () => api.get<RevertPreview>(`/admin/audit/${shown}/revert`),
    enabled: !!shown,
  });
  const close = () => {
    setCurrent(null);
    setReason('');
    setDone({});
    onClose();
  };
  const run = useMutation({
    mutationFn: () =>
      api.post<{ id: string; message: string }>(`/admin/audit/${shown}/revert`, { reason }),
    onSuccess: async (r) => {
      setDone((d) => ({ ...d, [shown!]: r.message }));
      setReason('');
      await qc.invalidateQueries({ queryKey: ['revert-preview'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      // Back to the action first asked for, which may now be possible.
      if (current && current !== id) setCurrent(null);
    },
  });
  const p = preview.data;

  return (
    <Dialog
      open={!!id}
      onClose={close}
      title="Annuler une action"
      description="L’annulation est elle-même enregistrée dans le journal, avec votre motif."
      className="max-w-2xl"
    >
      <div className="grid gap-3 text-sm">
        {preview.error ? <Alert>{preview.error.message}</Alert> : null}
        {p ? (
          <>
            <p>
              <strong>{p.entry.actorName ?? 'Le système'}</strong> {p.entry.sentence}, le{' '}
              {formatDateTime(p.entry.at)}.
            </p>
            {p.siblings.length ? (
              <Alert variant="info">
                Enregistré en même temps, et annulé avec :{' '}
                {p.siblings.map((s) => s.sentence).join(' ; ')}.
              </Alert>
            ) : null}
            {id && shown === id && done[id] === undefined && Object.keys(done).length ? (
              <Alert variant="success">
                L’action la plus récente est annulée ({Object.values(done).join(' ')}). Vous pouvez
                maintenant annuler celle-ci.
              </Alert>
            ) : null}
            {shown && done[shown] !== undefined ? (
              <Alert variant="success">{done[shown]}</Alert>
            ) : p.revertedBy ? (
              <Alert variant="info">
                Déjà annulée le {formatDateTime(p.revertedBy.at)}
                {p.revertedBy.actorName ? ` par ${p.revertedBy.actorName}` : ''}.
              </Alert>
            ) : p.possible ? (
              <>
                <p className="font-medium">{p.label}</p>
                {p.message ? <p>Ce qui sera fait : {p.message}</p> : null}
                {p.steps.length ? (
                  <ul
                    className="grid max-h-72 gap-2 overflow-y-auto"
                    aria-label="Ce qui sera remis"
                  >
                    {p.steps.map((s, i) => (
                      <li key={i} className="rounded-md border p-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {tableLabel(s.table)}
                          {s.kind === 'delete'
                            ? ' — sera retiré'
                            : s.kind === 'insert'
                              ? ' — sera recréé'
                              : ''}
                        </span>
                        {s.kind === 'update' ? (
                          <AuditDiff before={s.current} after={s.values} />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Field label="Motif (obligatoire)">
                  {(f) => (
                    <Input
                      {...f}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Erreur de saisie, mauvais foyer…"
                      autoFocus
                    />
                  )}
                </Field>
                {run.error ? <Alert>{run.error.message}</Alert> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={close}>
                    Fermer
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={reason.trim().length < 3 || run.isPending}
                    onClick={() => run.mutate()}
                  >
                    Annuler cette action
                  </Button>
                </div>
              </>
            ) : p.conflicts.length ? (
              <>
                <Alert>
                  Des éléments ont été modifiés depuis : l’annulation les écraserait. Annulez
                  d’abord l’action la plus récente.
                </Alert>
                <ul className="grid gap-2" aria-label="Modifié depuis">
                  {p.conflicts.map((c, i) => (
                    <li key={i} className="rounded-md border p-2">
                      <span className="font-medium">{tableLabel(c.table)}</span> :{' '}
                      {CONFLICT_TEXT[c.kind]}
                      {c.columns.length ? ` (${c.columns.join(', ')})` : ''}
                      {c.by ? (
                        <span className="block text-muted-foreground">
                          {c.by.actorName ?? 'Quelqu’un'} {c.by.sentence ?? 'a modifié cet élément'}
                          , le {formatDateTime(c.by.at)}
                          {c.by.auditId ? (
                            <Button
                              variant="link"
                              className="h-auto px-1 py-0"
                              onClick={() => {
                                setReason('');
                                setCurrent(c.by!.auditId);
                              }}
                            >
                              Annuler d’abord celle-ci
                            </Button>
                          ) : (
                            ' (directement dans la base)'
                          )}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <Alert variant="info">{p.reason}</Alert>
                {p.link ? (
                  <Link to={p.link} className="text-primary hover:underline" onClick={close}>
                    Ouvrir l’écran concerné
                  </Link>
                ) : null}
              </>
            )}
            {current && current !== id ? (
              <Button
                variant="link"
                className="justify-self-start px-0"
                onClick={() => setCurrent(null)}
              >
                ← Revenir à l’action de départ
              </Button>
            ) : null}
          </>
        ) : preview.isPending ? (
          <p className="text-muted-foreground">Préparation de l’aperçu…</p>
        ) : null}
      </div>
    </Dialog>
  );
}
