import { hasAnyRole } from '@episoft/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import {
  applyPayment,
  canAddPayment,
  DEFAULT_THRESHOLDS,
  centsToDecimal,
  formatEuro,
  parseAmountToCents,
  PAYMENT_METHOD_LABELS,
  paymentState,
  walletPaymentAllowed,
  type PaymentMethod,
  type SnapshotMember,
} from '@episoft/shared';
import { useMe } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Checkbox, Input, Label } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import type { PaymentDraft } from './logic';
import { useTill } from './context';

const eur = (c: number) => formatEuro(centsToDecimal(c));

export interface PaymentResult {
  payments: PaymentDraft[];
  emailReceipt: boolean;
  overdraftForcedBy: string | null;
}

/**
 * R-VTE-09: several methods, the remaining amount recomputed after each payment, change
 * only for cash, one button per payment (no double entry), editable summary.
 */
export function PaymentDialog({
  open,
  totalCents,
  member,
  onClose,
  onConfirm,
}: {
  open: boolean;
  totalCents: number;
  member: SnapshotMember | null;
  onClose: () => void;
  onConfirm: (r: PaymentResult) => Promise<void>;
}) {
  const me = useMe();
  const { settings, balanceCents } = useTill();
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [changeChecked, setChangeChecked] = useState(false);
  const [force, setForce] = useState(false);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  const state = paymentState(totalCents, payments);
  const change = payments.reduce((s, p) => s + (p.changeCents ?? 0), 0);
  const householdId = member?.householdId ?? null;
  const changeHigh =
    change > Math.round((settings?.thresholds ?? DEFAULT_THRESHOLDS).changeAmount * 100);
  const balance = householdId ? balanceCents(householdId) : null;
  const walletUsed = payments
    .filter((p) => p.method === 'WALLET')
    .reduce((s, p) => s + p.amountCents, 0);
  const overdraft = parseAmountToCents(settings?.overdraftLimit ?? '0') ?? 0;
  const canForce = hasAnyRole(me.roles, ['ADHERENTS']);

  useEffect(() => {
    if (open) {
      setPayments([]);
      setMethod(null); // R-EVO-02: no method is preselected
      setInput(centsToDecimal(totalCents).replace('.', ','));
      setError(null);
      setForce(false);
      setChangeChecked(false);
    }
  }, [open, totalCents]);

  useEffect(() => {
    setInput(
      state.remainingCents > 0 ? centsToDecimal(state.remainingCents).replace('.', ',') : '',
    );
    amountRef.current?.select();
  }, [state.remainingCents, method]);

  const methods: PaymentMethod[] = [
    'CASH',
    'CARD',
    'CHEQUE',
    'WALLET',
    ...(settings?.allowTransfer ? (['TRANSFER'] as const) : []),
  ];

  const add = (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (!method || !canAddPayment(method, state.remainingCents))
      return setError('Choisissez un mode de règlement.');
    const typed = parseAmountToCents(input);
    if (typed === null || typed <= 0) return setError('Montant invalide.');
    if (method === 'WALLET') {
      if (!householdId) return setError('Le paiement par cagnotte exige un adhérent.');
      const { amountCents } = applyPayment(state.remainingCents, method, typed);
      if (
        balance !== null &&
        !walletPaymentAllowed(balance - walletUsed, amountCents, overdraft) &&
        !force
      ) {
        return setError(
          `Solde de cagnotte insuffisant (${eur(balance - walletUsed)}).${canForce ? ' Cochez « Forcer le découvert » pour passer outre.' : ''}`,
        );
      }
    }
    const { amountCents, changeCents } = applyPayment(state.remainingCents, method, typed);
    if (amountCents <= 0) return;
    setPayments([
      ...payments,
      {
        method,
        amountCents,
        ...(method === 'CASH' ? { tenderedCents: typed, changeCents } : {}),
      },
    ]);
  };

  const confirm = async () => {
    setSaving(true);
    try {
      await onConfirm({
        payments,
        // R-EVO-40: the server sends the ticket by itself; the flag is kept for old tills.
        emailReceipt: false,
        overdraftForcedBy: force && canForce ? me.id : null,
      });
    } finally {
      setSaving(false);
    }
  };

  const changeToWallet = payments.some((p) => p.changeToWallet);
  const toggleChangeToWallet = (on: boolean) =>
    setPayments(
      payments.map((p) =>
        p.method === 'CASH' && (p.changeCents ?? 0) > 0 ? { ...p, changeToWallet: on } : p,
      ),
    );

  return (
    <Dialog open={open} onClose={onClose} title="Règlement" className="max-w-xl">
      <div className="grid gap-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-muted p-2">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-semibold tabular-nums">{eur(totalCents)}</p>
          </div>
          <div className="rounded-md bg-muted p-2">
            <p className="text-xs text-muted-foreground">Payé</p>
            <p className="text-xl font-semibold tabular-nums">{eur(state.paidCents)}</p>
          </div>
          <div
            className={cn(
              'rounded-md p-2',
              state.remainingCents > 0 ? 'bg-primary/10' : 'bg-success/15',
            )}
          >
            <p className="text-xs text-muted-foreground">Reste à payer</p>
            <p className="text-xl font-semibold tabular-nums" data-testid="remaining">
              {eur(state.remainingCents)}
            </p>
          </div>
        </div>

        {state.remainingCents > 0 ? (
          <form onSubmit={add} className="grid gap-3">
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-5"
              role="radiogroup"
              aria-label="Mode de règlement"
            >
              {methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  onClick={() => setMethod(m)}
                  disabled={m === 'WALLET' && !householdId}
                  className={cn(
                    'min-h-11 rounded-md border px-2 text-sm font-medium disabled:opacity-40',
                    method === m
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:bg-accent',
                  )}
                >
                  {PAYMENT_METHOD_LABELS[m]}
                </button>
              ))}
            </div>
            {method === 'WALLET' && balance !== null ? (
              <p className="text-sm text-muted-foreground">
                Solde estimé de la cagnotte :{' '}
                <strong className={balance - walletUsed < 0 ? 'text-destructive' : ''}>
                  {eur(balance - walletUsed)}
                </strong>
              </p>
            ) : null}
            <div className="flex gap-2">
              <Input
                ref={amountRef}
                aria-label={method === 'CASH' ? 'Montant remis' : 'Montant'}
                disabled={!method}
                inputMode="decimal"
                className="h-11 text-lg"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoFocus
              />
              <Button type="submit" size="lg" disabled={!method}>
                Ajouter
              </Button>
            </div>
            {method === 'WALLET' && canForce ? (
              <div className="flex items-center gap-2">
                <Checkbox id="force" checked={force} onChange={(e) => setForce(e.target.checked)} />
                <Label htmlFor="force" className="font-normal">
                  Forcer le découvert (journalisé)
                </Label>
              </div>
            ) : null}
          </form>
        ) : null}

        {error ? <Alert>{error}</Alert> : null}

        {payments.length ? (
          <ul className="grid gap-1" aria-label="Règlements saisis">
            {payments.map((p, i) => (
              <li
                key={i}
                className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
              >
                <span>
                  {PAYMENT_METHOD_LABELS[p.method]} {eur(p.amountCents)}
                  {p.tenderedCents && p.tenderedCents !== p.amountCents ? (
                    <span className="text-muted-foreground"> (remis {eur(p.tenderedCents)})</span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Supprimer ce règlement"
                  onClick={() => setPayments(payments.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {changeHigh ? (
          <div className="grid gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm">
            <p className="font-medium">
              La monnaie à rendre est élevée ({eur(change)}). Vérifiez la somme remise par le
              client.
            </p>
            <div className="flex items-center gap-2">
              <Checkbox
                id="change-checked"
                checked={changeChecked}
                onChange={(e) => setChangeChecked(e.target.checked)}
              />
              <Label htmlFor="change-checked" className="font-normal">
                J’ai vérifié la somme remise et la monnaie
              </Label>
            </div>
          </div>
        ) : null}

        {change > 0 ? (
          <div className="grid gap-2 rounded-md bg-warning/15 p-3">
            <p className="text-lg font-semibold">
              Monnaie à rendre : {changeToWallet ? eur(0) : eur(change)}
            </p>
            {householdId ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="ctw"
                  checked={changeToWallet}
                  onChange={(e) => toggleChangeToWallet(e.target.checked)}
                />
                <Label htmlFor="ctw" className="font-normal">
                  Verser la monnaie ({eur(change)}) sur la cagnotte
                </Label>
              </div>
            ) : null}
          </div>
        ) : null}

        {member?.hasEmail ? (
          <p className="text-sm text-muted-foreground">
            Le ticket sera envoyé par courriel à {member.firstName} {member.lastName}, avec le solde
            de la cagnotte avant et après.
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Retour au ticket
          </Button>
          <Button
            size="lg"
            onClick={confirm}
            disabled={!state.settled || saving || (changeHigh && !changeChecked)}
          >
            Valider le ticket
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
