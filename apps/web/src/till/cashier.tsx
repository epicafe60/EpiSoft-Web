import { useEffect, useState, type FormEvent } from 'react';
import { sha256Hex } from '@episoft/shared';
import { useMe } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { setMeta, tillDb } from './db';

/**
 * R-AUTH-04: on a till already opened by an authenticated user, a cashier badge switches
 * the cashier recorded on the tickets. It never opens the back-office. Works offline:
 * badges are compared in hashed form with the local copy (R-SYNC-06).
 */
export function CashierSwitch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setToken('');
      setError(null);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const hash = await sha256Hex(token.trim());
    const m = await tillDb.members.where('qrTokenHash').equals(hash).first();
    if (!m) return setError('Badge inconnu.');
    if (!m.isCashier) return setError(`${m.firstName} ${m.lastName} n’a pas le rôle Caisse.`);
    await setMeta('cashierId', m.id);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Changer de caissier"
      description="Scannez le badge du nouveau caissier."
    >
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Badge" error={error ?? undefined}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoFocus
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-between gap-2">
          <Button
            variant="ghost"
            onClick={async () => {
              await setMeta('cashierId', me.id);
              onClose();
            }}
          >
            Revenir à {me.firstName}
          </Button>
          <Button type="submit">Valider</Button>
        </div>
      </form>
    </Dialog>
  );
}
