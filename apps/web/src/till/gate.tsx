import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { centsToDecimal, parseAmountToCents } from '@episoft/shared';
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

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-start justify-center px-4 pt-[8vh]">{children}</div>;
}

/** First use of a browser as a till: it gets a name and an id from the server (R-ADM-03). */
function DeviceSetup() {
  const { engine } = useTill();
  const [name, setName] = useState('CAISSE1');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      const d = await api.post<{ id: string; name: string }>('/pos/devices', { name: name.trim() });
      await setMeta('device', d);
      await engine.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enregistrement impossible.');
    } finally {
      setPending(false);
    }
  };
  return (
    <Centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Déclarer ce poste de caisse</CardTitle>
          <CardDescription>
            À faire une seule fois, avec le réseau. Le poste garde ensuite ses ventes même hors
            ligne.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <Field label="Nom du poste" hint="Il préfixe les numéros provisoires des tickets.">
              {(p) => (
                <Input
                  {...p}
                  value={name}
                  maxLength={40}
                  onChange={(e) => setName(e.target.value.toUpperCase())}
                />
              )}
            </Field>
            {error ? <Alert>{error}</Alert> : null}
            <Button type="submit" disabled={pending || !name.trim()}>
              Déclarer le poste
            </Button>
          </form>
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

  // A session already open on the server (opened earlier from this device) is adopted.
  useEffect(() => {
    const open = state.data?.openSession;
    if (open) void setMeta('session', open);
  }, [state.data]);

  // R-EVO-06: a session opened on another till is the shop's: join it (one drawer, one closing).
  const others = (settings?.openSessions ?? []).filter((s) => s.id !== state.data?.openSession?.id);

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
          {others.length ? (
            <div className="mb-5 grid gap-2 rounded-md border bg-muted/40 p-3">
              <p className="text-sm font-medium">Une session est déjà ouverte dans l’épicerie</p>
              {others.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">
                    {s.deviceName}, ouverte à {formatDateTime(s.openedAt)} (fond{' '}
                    {euro(s.openingFloat)})
                  </span>
                  <Button
                    onClick={() =>
                      void setMeta('session', {
                        id: s.id,
                        openedAt: s.openedAt,
                        openingFloat: s.openingFloat,
                      })
                    }
                  >
                    Rejoindre cette session
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Un seul tiroir-caisse et une seule clôture. Ne l’ouvrez à part que si ce poste a son
                propre tiroir.
              </p>
            </div>
          ) : null}
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
  const { meta } = useTill();
  if (!meta.device) return <DeviceSetup />;
  if (needSession && !meta.session) return <OpenSession />;
  return <>{children}</>;
}
