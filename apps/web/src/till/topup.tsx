import { useEffect, useState, type FormEvent } from 'react';
import {
  centsToDecimal,
  formatEuro,
  MEMBER_PAYMENT_METHODS,
  parseAmountToCents,
  PAYMENT_METHOD_LABELS,
  type MemberPaymentMethod,
  type SnapshotMember,
} from '@episoft/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Field, Input, Label } from '@/components/ui/form';
import { Select } from '@/components/ui/inputs';
import { useTill } from './context';
import { enqueue } from './sync';

/** Top-up at the till (R-CAG-01), recorded on the session and sent like a sale. */
export function TopupDialog({
  open,
  onClose,
  householdId,
  member,
}: {
  open: boolean;
  onClose: () => void;
  householdId: string;
  member: SnapshotMember;
}) {
  const { meta, cashierId, engine, balanceCents } = useTill();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<MemberPaymentMethod>('CASH');
  const [receipt, setReceipt] = useState(member.hasEmail);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAmount('');
      setMethod('CASH');
      setReceipt(member.hasEmail);
      setError(null);
    }
  }, [open, member.hasEmail]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = parseAmountToCents(amount);
    if (cents === null || cents <= 0) return setError('Montant invalide.');
    await enqueue((deviceSeq) => ({
      kind: 'WALLET_TOPUP',
      id: crypto.randomUUID(),
      deviceSeq,
      payload: {
        sessionId: meta.session!.id,
        cashierId,
        householdId,
        amount: centsToDecimal(cents),
        method,
        at: new Date().toISOString(),
        emailReceipt: receipt,
      },
    }));
    engine.kick();
    onClose();
  };

  const balance = balanceCents(householdId);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Versement sur la cagnotte"
      description={`Foyer de ${member.firstName} ${member.lastName} · solde estimé ${balance !== null ? formatEuro(centsToDecimal(balance)) : '—'}`}
    >
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Montant (€)">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                autoFocus
                className="h-11 text-lg"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label="Mode">
            {(p) => (
              <Select
                {...p}
                className="h-11"
                value={method}
                onChange={(e) => setMethod(e.target.value as MemberPaymentMethod)}
              >
                {MEMBER_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {member.hasEmail ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="topup-receipt"
              checked={receipt}
              onChange={(e) => setReceipt(e.target.checked)}
            />
            <Label htmlFor="topup-receipt" className="font-normal">
              Envoyer le reçu par courriel (R-CAG-06)
            </Label>
          </div>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        <Button type="submit" size="lg">
          Enregistrer le versement
        </Button>
      </form>
    </Dialog>
  );
}
