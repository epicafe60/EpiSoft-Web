import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { centsToDecimal, parseAmountToCents, parisDay } from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { euro } from '@/lib/format';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Field, Input } from '@/components/ui/form';
import { setMeta } from './db';
import { useDeviceState, useTill } from './context';
import { enqueue } from './sync';
import { newDeviceName } from './logic';

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-start justify-center px-4 pt-[8vh]">{children}</div>;
}

/**
 * First use of a browser as a till: it is declared on its own, with a generated name (R-ADM-03).
 * Nobody has to know which « poste » they are on: the session is the shop's.
 */
function DeviceSetup() {
  const { engine } = useTill();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // One declaration per attempt, even when the page mounts the effect twice (development).
  const started = useRef(-1);
  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    void (async () => {
      setError(null);
      for (let i = 0; i < 5; i++) {
        try {
          const d = await api.post<{ id: string; name: string }>('/pos/devices', {
            // Tests choose the name (window.__EPISOFT_DEVICE_NAME); nobody else needs to.
            name:
              (i === 0
                ? (window as { __EPISOFT_DEVICE_NAME?: string }).__EPISOFT_DEVICE_NAME
                : undefined) ?? newDeviceName(),
          });
          await setMeta('device', d);
          await engine.refresh();
          return;
        } catch (err) {
          // A name already taken (409): another is drawn.
          if (err instanceof ApiError && err.status === 409) continue;
          setError(
            err instanceof ApiError
              ? err.message
              : 'Le serveur est injoignable : la première ouverture de la caisse demande le réseau.',
          );
          return;
        }
      }
      setError('Enregistrement du poste impossible.');
    })();
  }, [engine, attempt]);
  return (
    <Centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Préparation de la caisse</CardTitle>
          <CardDescription>
            Ce navigateur est enregistré comme poste de caisse. Cela ne se fait qu’une fois, avec le
            réseau.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error ? (
            <>
              <Alert>{error}</Alert>
              <Button onClick={() => setAttempt((n) => n + 1)}>Réessayer</Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Un instant…</p>
          )}
        </CardContent>
      </Card>
    </Centered>
  );
}

/**
 * The open session is from a previous day (R-SES-05): the shop's till is the day's. It is closed
 * (count of the cash) before anything is sold in the new day.
 */
function StaleSession({
  session,
}: {
  session: { id: string; openedAt: string; openingFloat: string };
}) {
  const navigate = useNavigate();
  return (
    <Centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>La caisse d’hier n’est pas clôturée</CardTitle>
          <CardDescription>
            La session ouverte le {formatDateTime(session.openedAt)} n’a pas été clôturée. Comptez
            les espèces et clôturez-la : une nouvelle caisse s’ouvrira ensuite pour aujourd’hui.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            size="lg"
            className="w-full"
            onClick={async () => {
              await setMeta('session', session);
              await navigate({ to: '/caisse/cloture' });
            }}
          >
            Clôturer cette caisse
          </Button>
        </CardContent>
      </Card>
    </Centered>
  );
}

/** R-SES-01: opening a session, possible offline (the session id is generated here). */
function OpenSession() {
  const me = useMe();
  const { meta, settings, engine, cashierId } = useTill();
  const state = useDeviceState(meta.device!.id);
  const [float, setFloat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // R-SES-05: the session open in the shop is joined without asking (one drawer, one closing).
  // The server's answer is trusted only when it is fresh: the copy kept from before a closing
  // would join a session that has just been closed. Offline, the last snapshot says.
  const fresh = state.isSuccess && !state.isFetching;
  const serverOpen = fresh
    ? (state.data.openSession ?? null)
    : state.isError
      ? (settings?.openSessions?.[0] ?? null)
      : undefined;
  const stale = !!serverOpen && parisDay(new Date(serverOpen.openedAt)) < parisDay(new Date());
  useEffect(() => {
    if (serverOpen && !stale)
      void setMeta('session', {
        id: serverOpen.id,
        openedAt: serverOpen.openedAt,
        openingFloat: serverOpen.openingFloat,
      });
  }, [serverOpen, stale]);

  const proposed = state.data?.proposedFloat ?? settings?.defaultFloat ?? '0.00';
  const value = float ?? proposed.replace('.', ',');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = parseAmountToCents(value);
    if (cents === null || cents < 0) {
      setError('Montant invalide.');
      return;
    }
    const session = {
      id: crypto.randomUUID(),
      openedAt: new Date().toISOString(),
      openingFloat: centsToDecimal(cents),
    };
    await enqueue(
      (deviceSeq) => ({
        kind: 'SESSION_OPEN',
        id: session.id,
        deviceSeq,
        payload: {
          sessionId: session.id,
          openedBy: cashierId,
          openedAt: session.openedAt,
          openingFloat: session.openingFloat,
        },
      }),
      () => setMeta('session', session),
    );
    engine.kick();
  };

  if (serverOpen && stale)
    return (
      <StaleSession
        session={{
          id: serverOpen.id,
          openedAt: serverOpen.openedAt,
          openingFloat: serverOpen.openingFloat,
        }}
      />
    );
  if (serverOpen) return null; // joined just above
  return (
    <Centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Ouvrir la caisse</CardTitle>
          <CardDescription>
            Bonjour {me.firstName}. Comptez le fond de caisse avant de commencer.
            {state.isError ? ' (Hors ligne : la session sera envoyée au retour du réseau.)' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <Field
              label="Fond de caisse (€)"
              hint={`Proposé : ${euro(proposed)} (fin de la session précédente).`}
              error={error ?? undefined}
            >
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  autoFocus
                  value={value}
                  onChange={(e) => setFloat(e.target.value)}
                  className="text-lg"
                />
              )}
            </Field>
            <Button type="submit" size="lg">
              Ouvrir la session
            </Button>
          </form>
        </CardContent>
      </Card>
    </Centered>
  );
}

/** Renders the till only once a device is declared and a session is open. */
export function TillGate({
  children,
  needSession = true,
}: {
  children: ReactNode;
  needSession?: boolean;
}) {
  const { meta, sync } = useTill();
  if (!meta.device) return <DeviceSetup />;
  if (needSession && !meta.session) return <OpenSession />;
  // The session of a previous day is closed first (online only: a till that cannot reach the
  // server keeps selling, the tickets are flagged when they arrive).
  if (
    needSession &&
    sync.online &&
    meta.session &&
    parisDay(new Date(meta.session.openedAt)) < parisDay(new Date())
  )
    return <StaleSession session={meta.session} />;
  return <>{children}</>;
}
