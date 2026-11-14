import { useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_KINDS,
  FEEDBACK_MODULES,
  feedbackCreateSchema,
  moduleOfPath,
  type FeedbackKind,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { formatDateTime } from '@/lib/utils';
import { Alert, Field, Input } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/** « Signaler un problème ou une idée »: opens from any screen, pre-filled with where the person is. */
export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Signaler un problème ou une idée"
      description="Votre message est lu par l’équipe qui fait évoluer l’application."
      className="max-w-xl"
    >
      <FeedbackForm onClose={onClose} />
    </Dialog>
  );
}

/** Mounted only while the dialog is open: it starts empty and pre-filled each time. */
function FeedbackForm({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [openedAt] = useState(() => new Date().toISOString());
  const [kind, setKind] = useState<FeedbackKind>('BUG');
  const [module, setModule] = useState<string>(() => moduleOfPath(pathname));
  const [screen, setScreen] = useState(() =>
    typeof document === 'undefined' ? '' : document.title,
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const send = useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string; number: string }>('/feedback', body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['feedback'] }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = feedbackCreateSchema.safeParse({
      kind,
      module,
      screen,
      title,
      description,
      steps,
      // Where the report is made, never what is typed in the page.
      context: {
        page: pathname,
        userAgent: navigator.userAgent.slice(0, 300),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      },
    });
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? ''), i.message])),
      );
      return;
    }
    setErrors({});
    send.mutate(parsed.data);
  };

  if (send.data)
    return (
      <div className="grid gap-4">
        <Alert variant="success">
          Merci ! Votre signalement <strong>{send.data.number}</strong> est enregistré. Vous serez
          prévenu par courriel quand l’équipe y répond.
        </Alert>
        <div className="flex justify-end gap-2">
          <Link
            to="/signalements"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent"
          >
            Voir mes signalements
          </Link>
          <Button onClick={onClose}>Fermer</Button>
        </div>
      </div>
    );

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        De la part de{' '}
        <strong>
          {me.firstName} {me.lastName}
        </strong>
        , le {formatDateTime(openedAt)}. Ces informations sont ajoutées automatiquement.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" error={errors.kind}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as FeedbackKind)}>
              {FEEDBACK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FEEDBACK_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Module" error={errors.module}>
          {(p) => (
            <Select {...p} value={module} onChange={(e) => setModule(e.target.value)}>
              {FEEDBACK_MODULES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field
        label="Écran concerné"
        error={errors.screen}
        hint="Rempli avec la page où vous êtes ; corrigez si besoin."
      >
        {(p) => (
          <Input
            {...p}
            value={screen}
            maxLength={120}
            onChange={(e) => setScreen(e.target.value)}
          />
        )}
      </Field>
      <Field label="Titre" error={errors.title}>
        {(p) => (
          <Input
            {...p}
            value={title}
            maxLength={120}
            placeholder={
              kind === 'BUG' ? 'Ce qui ne marche pas' : 'Ce que vous aimeriez pouvoir faire'
            }
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      <Field
        label={kind === 'BUG' ? 'Ce qui se passe, et ce que vous attendiez' : 'Votre idée'}
        error={errors.description}
      >
        {(p) => (
          <Textarea
            {...p}
            rows={4}
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
      <Field
        label={
          kind === 'BUG' ? 'Étapes pour reproduire le problème' : 'Étapes ou exemple (facultatif)'
        }
        error={errors.steps}
        hint={kind === 'BUG' ? '1. Ouvrir… 2. Cliquer sur… 3. Le message apparaît.' : undefined}
      >
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={steps}
            maxLength={3000}
            onChange={(e) => setSteps(e.target.value)}
          />
        )}
      </Field>
      {send.error ? <Alert>{send.error.message}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Annuler
        </Button>
        <Button type="submit" disabled={send.isPending}>
          {send.isPending ? 'Envoi…' : 'Envoyer'}
        </Button>
      </div>
    </form>
  );
}
