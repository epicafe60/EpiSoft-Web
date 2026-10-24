import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';

export interface ConfirmOptions {
  title: string;
  /** What is about to happen, in plain words. */
  message: ReactNode;
  /** The consequences, one line each (« 42 produits seront modifiés »). */
  impact?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red button: the action cannot be undone. */
  destructive?: boolean;
  /** A reason to type (the answer is then the text, or null when cancelled). */
  input?: { label: string; minLength?: number; placeholder?: string };
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;
type AskText = (
  o: ConfirmOptions & { input: NonNullable<ConfirmOptions['input']> },
) => Promise<string | null>;

interface Api {
  ask: Ask;
  askText: AskText;
}

const ConfirmContext = createContext<Api | null>(null);

/** For code outside a component's render (an event handler): the provider registers itself here. */
let live: Api | null = null;

/** `await confirmNow({ ... })` from any event handler, without a hook. */
export function confirmNow(o: ConfirmOptions): Promise<boolean> {
  if (!live) throw new Error('confirmNow() hors de ConfirmProvider');
  return live.ask(o);
}

/** `await promptNow({ ..., input })`: the typed text, or null when cancelled. */
export function promptNow(
  o: ConfirmOptions & { input: NonNullable<ConfirmOptions['input']> },
): Promise<string | null> {
  if (!live) throw new Error('promptNow() hors de ConfirmProvider');
  return live.askText(o);
}

/**
 * One confirmation window for the whole application, replacing the browser's `window.confirm`
 * and `window.prompt`: same look everywhere, the consequences spelled out, and the buttons say
 * what they do. `const ok = await confirm({ ... })`, `const reason = await prompt({ ..., input })`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [text, setText] = useState('');
  const resolver = useRef<((v: string | boolean | null) => void) | null>(null);

  const open = useCallback((o: ConfirmOptions) => {
    // A second question while one is open: the first one is answered « no ».
    resolver.current?.(o.input ? null : false);
    setText('');
    setOpts(o);
    return new Promise<string | boolean | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const ask = useCallback<Ask>(async (o) => (await open(o)) === true, [open]);
  const askText = useCallback<AskText>(
    async (o) => {
      const v = await open(o);
      return typeof v === 'string' ? v : null;
    },
    [open],
  );

  const close = (value: string | boolean | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpts(null);
  };
  const need = opts?.input?.minLength ?? 1;
  const textOk = !opts?.input || text.trim().length >= need;

  // Registered once mounted (not during the render), for confirmNow / promptNow.
  useEffect(() => {
    live = { ask, askText };
    return () => {
      live = null;
    };
  }, [ask, askText]);
  return (
    <ConfirmContext.Provider value={{ ask, askText }}>
      {children}
      <Dialog
        open={!!opts}
        onClose={() => close(opts?.input ? null : false)}
        title={opts?.title ?? ''}
      >
        {opts ? (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (textOk) close(opts.input ? text.trim() : true);
            }}
          >
            <div className="text-sm">{opts.message}</div>
            {opts.impact?.length ? (
              <ul
                className="grid gap-1 rounded-md border bg-muted/40 p-3 text-sm"
                aria-label="Conséquences"
              >
                {opts.impact.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            {opts.input ? (
              <label className="grid gap-1 text-sm font-medium">
                {opts.input.label}
                <Input
                  autoFocus
                  value={text}
                  placeholder={opts.input.placeholder}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => close(opts.input ? null : false)}
                autoFocus={!opts.input}
              >
                {opts.cancelLabel ?? 'Annuler'}
              </Button>
              <Button
                type="submit"
                variant={opts.destructive ? 'destructive' : 'default'}
                disabled={!textOk}
              >
                {opts.confirmLabel ?? 'Confirmer'}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ask {
  const api = useContext(ConfirmContext);
  if (!api) throw new Error('useConfirm() hors de ConfirmProvider');
  return api.ask;
}

/** A question that needs a few words in answer (a reason, a note); null when cancelled. */
export function usePrompt(): AskText {
  const api = useContext(ConfirmContext);
  if (!api) throw new Error('usePrompt() hors de ConfirmProvider');
  return api.askText;
}
