import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { tillPinSchema, type CashierCheck, type Me, type SnapshotMember } from '@episoft/shared';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Field, Input, PasswordInput } from '@/components/ui/form';
import { getMeta, setMeta, tillDb } from './db';
import { cashierStep, type CashierStep } from './logic';
import { useTill } from './context';

// R-SES-07: changing the cashier without signing out. The session of the person signed in stays
// open; the chosen cashier's name goes on the tickets. With the code required, they type it.

const OPEN_EVENT = 'episoft:till-cashier';

/** Asks « Qui encaisse ? » from anywhere in the till (header, sale screen, idle check). */
export function openCashierSwitch(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function useCashierSwitchRequests(onOpen: () => void): void {
  useEffect(() => {
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [onOpen]);
}

const fullName = (m: { firstName: string; lastName: string }) => `${m.firstName} ${m.lastName}`;

/** The server could not be reached while a code was being checked. */
class Unreachable extends Error {}

/** The cashiers known to the till (the snapshot), the active ones first. */
function useCashiers(online: boolean) {
  const members = useLiveQuery(
    () =>
      tillDb.members
        .filter((m) => m.isCashier && m.status !== 'INACTIVE' && m.status !== 'ARCHIVED')
        .toArray(),
    [],
  );
  const { data: connected } = useQuery({
    queryKey: ['till-connected'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/pos/connected'),
    enabled: online,
    refetchInterval: 30_000,
  });
  const recent = new Set((connected ?? []).map((c) => c.id));
  return (members ?? []).sort(
    (a, b) =>
      Number(recent.has(b.id)) - Number(recent.has(a.id)) ||
      a.firstName.localeCompare(b.firstName, 'fr'),
  );
}

/** The password of the person signed in, typed again: the till and the rest are theirs again. */
export function UnlockForm({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/unlock', { password });
      // The copy of /me first: the till adopts the cashier the server names, and an old copy
      // would hand the till straight back to the previous cashier.
      queryClient.setQueryData<Me | null>(['me'], (m) => (m ? { ...m, tillCashierId: null } : m));
      await setMeta('cashier', null);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? 'Il faut être en ligne pour reprendre votre compte.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-3">
      <Field label={`Mot de passe de ${fullName(me)}`}>
        {(p) => (
          <PasswordInput
            {...p}
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      {error ? <Alert>{error}</Alert> : null}
      <Button type="submit" disabled={busy || !password}>
        Revenir à mon compte
      </Button>
    </form>
  );
}

/** Four digits, masked, typed with the on-screen keys or the keyboard. */
function PinPad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const press = (d: string) => onChange((value + d).slice(0, 4));
  return (
    <div className="grid justify-items-center gap-3">
      <Input
        aria-label="Code caissier (4 chiffres)"
        inputMode="numeric"
        autoComplete="off"
        type="password"
        maxLength={4}
        autoFocus
        className="w-32 text-center text-2xl tracking-[0.5em]"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
      />
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) =>
          k === '' ? (
            <span key="blank" />
          ) : (
            <Button
              key={k}
              type="button"
              variant="outline"
              className="h-12 w-16 text-lg"
              onClick={() => (k === '⌫' ? onChange(value.slice(0, -1)) : press(k))}
            >
              {k}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

export function CashierSwitchDialog({
  open,
  onClose,
  online,
  pinRequired,
  activeId,
}: {
  open: boolean;
  onClose: () => void;
  online: boolean;
  pinRequired: boolean;
  activeId: string;
}) {
  const { appName } = useBranding();
  const me = useMe();
  const { engine } = useTill();
  const queryClient = useQueryClient();
  const cashiers = useCashiers(online && open);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<SnapshotMember | null>(null);
  const [step, setStep] = useState<CashierStep | null>(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setChosen(null);
    setStep(null);
    setPin('');
    setPin2('');
    setPassword('');
    setError(null);
  }, [open]);

  /**
   * The cashier keeps the till from now on. The code is checked by the SERVER only (the till holds
   * no copy of it, not even hashed): online, it answers with how the cashier was established and a
   * proof the tickets then carry. Without the network the cashier is only declared, and the tickets
   * are flagged « non vérifié ».
   */
  const finish = async (m: SnapshotMember, code?: string) => {
    let check: CashierCheck = 'DECLARED';
    let proof: string | null = null;
    if (online) {
      try {
        const r = await api.post<{ check: CashierCheck; proof?: string | null }>('/pos/cashier', {
          cashierId: m.id,
          ...(code ? { pin: code } : {}),
        });
        check = r.check;
        proof = r.proof ?? null;
      } catch (e) {
        // The network dropped while the till still believed to be online: a code that cannot be
        // checked is not accepted, the cashier can be declared instead.
        if (e instanceof ApiError && e.status === 0) throw new Unreachable();
        throw e;
      }
    }
    await setMeta('cashier', {
      id: m.id,
      check,
      proof,
      lastActivityAt: new Date().toISOString(),
    });
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    onClose();
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = (m: SnapshotMember) =>
    run(async () => {
      const next = cashierStep({
        chosenId: m.id,
        holderId: me.id,
        activeId,
        pinRequired,
        hasPin: !!m.hasTillPin,
        online,
      });
      setChosen(m);
      if (next !== 'done') return setStep(next);
      if (m.id === me.id) return onClose();
      await finish(m);
    });

  const submitPin = (e: FormEvent) => {
    e.preventDefault();
    const m = chosen!;
    void run(async () => {
      try {
        await finish(m, pin);
      } catch (err) {
        setPin('');
        // The server cannot be reached after all: the cashier can only be declared.
        if (err instanceof Unreachable) return setStep('declare');
        throw err;
      }
    });
  };

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    const m = chosen!;
    void run(async () => {
      const parsed = tillPinSchema.safeParse(pin);
      if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
      if (pin !== pin2) throw new Error('Les deux codes ne sont pas identiques.');
      await api.put(`/pos/cashiers/${m.id}/pin`, { password, pin });
      await finish(m, pin);
      void engine.refresh();
    });
  };

  const shown = cashiers.filter((m) =>
    `${m.firstName} ${m.lastName}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const title =
    step === 'unlock'
      ? 'Reprendre la caisse'
      : step && chosen
        ? fullName(chosen)
        : 'Qui encaisse ?';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={
        step
          ? undefined
          : 'Touchez votre nom : les ventes seront enregistrées à votre nom, sans vous déconnecter.'
      }
    >
      {!step ? (
        <div className="grid gap-3">
          <Input
            aria-label="Chercher un caissier"
            placeholder="Prénom…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="grid max-h-80 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {shown.map((m) => (
              <li key={m.id}>
                <Button
                  type="button"
                  variant={m.id === activeId ? 'default' : 'outline'}
                  className="h-12 w-full justify-start"
                  disabled={busy}
                  onClick={() => void choose(m)}
                >
                  {fullName(m)}
                  {m.id === me.id ? (
                    <span className="ml-auto text-xs opacity-70">connecté</span>
                  ) : null}
                </Button>
              </li>
            ))}
          </ul>
          {!shown.length ? (
            <p className="text-sm text-muted-foreground">Aucun bénévole caissier trouvé.</p>
          ) : null}
        </div>
      ) : step === 'unlock' ? (
        <UnlockForm onDone={onClose} />
      ) : step === 'pin' ? (
        <form onSubmit={submitPin} className="grid gap-4">
          <p className="text-sm text-muted-foreground">Tapez votre code caissier.</p>
          <PinPad value={pin} onChange={setPin} />
          <Button type="submit" disabled={busy || pin.length !== 4}>
            Valider
          </Button>
        </form>
      ) : step === 'create' ? (
        <form onSubmit={submitCreate} className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Vous n’avez pas encore de code caissier. Choisissez 4 chiffres, puis confirmez avec
            votre mot de passe {appName} : vous n’aurez plus à le taper pour prendre la caisse.
          </p>
          <PinPad value={pin} onChange={setPin} />
          <Field label="Le même code, encore une fois">
            {(p) => (
              <Input
                {...p}
                type="password"
                inputMode="numeric"
                maxLength={4}
                autoComplete="off"
                value={pin2}
                onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            )}
          </Field>
          <Field label={`Votre mot de passe ${appName}`}>
            {(p) => (
              <PasswordInput
                {...p}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || pin.length !== 4 || !password}>
              Choisir ce code
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => finish(chosen!))}
            >
              Plus tard (ventes signalées « non vérifié »)
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3">
          <Alert>
            Le poste est hors ligne : le code caissier est vérifié par le serveur et ne peut pas
            l’être maintenant. Les ventes seront enregistrées au nom de{' '}
            {chosen ? fullName(chosen) : ''}
            avec la mention « caissier non vérifié », à confirmer avec cette personne.
          </Alert>
          <Button type="button" disabled={busy} onClick={() => void run(() => finish(chosen!))}>
            Continuer
          </Button>
        </div>
      )}
      {error ? <Alert className="mt-3">{error}</Alert> : null}
      {step ? (
        <Button
          type="button"
          variant="link"
          className={cn('mt-2 px-0')}
          onClick={() => {
            setStep(null);
            setError(null);
            setPin('');
          }}
        >
          ← Choisir quelqu’un d’autre
        </Button>
      ) : null}
    </Dialog>
  );
}

/** The cashier's name for a member id (the snapshot of the till), for the screens outside it. */
export function useCashierName(id: string | null | undefined): string | null {
  return (
    useLiveQuery(async () => {
      if (!id) return null;
      const m = await tillDb.members.get(id);
      return m ? fullName(m) : null;
    }, [id]) ?? null
  );
}

/** The cashier set on this device (or null), for the screens outside the till. */
export function useLocalCashier() {
  return useLiveQuery(() => getMeta('cashier'), []);
}
