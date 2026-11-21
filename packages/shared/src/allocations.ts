import { centsToDecimal, decimalToCents, formatEuro } from './money';
import { PAYMENT_METHOD_LABELS } from './pos';
import type { OperationRow } from './operations';

// R-CPT-20: the extract of the accounting allocations, one line per ticket and per payment made
// outside a ticket, with what each one holds of donation, membership, top-up of the cagnotte and
// purchase. It is what the person who rebuilds the accounts asks for (one row per operation, the
// columns of their template). Pure rules: the server reads the operations, this builds the rows.

export const ALLOCATION_PASSING_MEMBER = 'Adhérent de passage';

/** A movement of the cagnotte that belongs to no ticket and to no payment (a historical debit, a correction). */
export interface WalletMovement {
  id: string;
  /** ISO date and time. */
  at: string;
  kind: 'PURCHASE' | 'CORRECTION';
  /** Signed: a debit is negative. */
  amount: string;
  comment: string | null;
  memberName: string | null;
}

export interface AllocationLine {
  id: string;
  /** ISO date and time of the operation. */
  at: string;
  label: string;
  who: string;
  mode: string;
  donCents: number;
  adhCents: number;
  /** Top-up of the cagnotte: not a purchase, it stays out of the total. */
  cagCents: number;
  achatCents: number;
  /** I = E + F + H. */
  totalCents: number;
  note: string;
}

const modeOf = (payments: OperationRow['payments']): string => {
  if (payments.length === 0) return '(non renseigné)';
  if (payments.length === 1) return PAYMENT_METHOD_LABELS[payments[0]!.method];
  return payments
    .map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatEuro(p.amount)}`)
    .join(' + ');
};

const line = (
  base: Pick<AllocationLine, 'id' | 'at' | 'label' | 'who' | 'mode'> & { note?: string },
  parts: { don?: number; adh?: number; cag?: number; achat?: number },
): AllocationLine => {
  const don = parts.don ?? 0;
  const adh = parts.adh ?? 0;
  const achat = parts.achat ?? 0;
  return {
    ...base,
    note: base.note ?? '',
    donCents: don,
    adhCents: adh,
    cagCents: parts.cag ?? 0,
    achatCents: achat,
    totalCents: don + adh + achat,
  };
};

/**
 * The lines of the extract, oldest first. A cancelled ticket is left out (it was struck and its
 * cancellation is not listed: the two cancel each other); the change of a cancelled ticket paid into
 * the cagnotte stays, as a top-up. A top-up is never part of the total.
 */
export function allocationLines(input: {
  operations: readonly OperationRow[];
  movements?: readonly WalletMovement[];
}): AllocationLine[] {
  const out: AllocationLine[] = [];
  for (const r of input.operations) {
    if (r.cancelled) continue;
    const who = r.memberName ?? ALLOCATION_PASSING_MEMBER;
    const total = decimalToCents(r.total);
    const base = { id: r.id, at: r.at, who, mode: modeOf(r.payments) };
    switch (r.type) {
      case 'SALE': {
        const don = decimalToCents(r.donation);
        const adh = decimalToCents(r.membership);
        out.push(
          line(
            { ...base, label: `Ticket n° ${r.number ?? '—'}` },
            { don, adh, cag: decimalToCents(r.walletCash), achat: total - don - adh },
          ),
        );
        break;
      }
      case 'TOPUP':
        out.push(line({ ...base, label: 'Versement sur cagnotte' }, { cag: total }));
        break;
      case 'MEMBERSHIP_PAYMENT':
        out.push(line({ ...base, label: 'Adhésion' }, { adh: total }));
        break;
      case 'DONATION_PAYMENT':
        out.push(line({ ...base, label: 'Don' }, { don: total }));
        break;
      default:
        out.push(
          line(
            { ...base, label: 'Autre versement', note: 'Versement sans motif standard.' },
            { achat: total },
          ),
        );
    }
  }
  for (const m of input.movements ?? []) {
    const cents = decimalToCents(m.amount);
    const who = m.memberName ?? ALLOCATION_PASSING_MEMBER;
    if (m.kind === 'PURCHASE' && cents < 0)
      out.push(
        line(
          {
            id: m.id,
            at: m.at,
            label: 'Achats réglés par la cagnotte',
            who,
            mode: PAYMENT_METHOD_LABELS.WALLET,
            note: 'Débit de cagnotte repris sans ticket (historique).',
          },
          { achat: -cents },
        ),
      );
    else
      out.push(
        line(
          {
            id: m.id,
            at: m.at,
            label: 'Correction de cagnotte',
            who,
            mode: PAYMENT_METHOD_LABELS.WALLET,
            note: m.comment ?? 'Correction manuelle de cagnotte, sans ticket.',
          },
          { cag: cents },
        ),
      );
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export interface AllocationTotals {
  count: number;
  don: string;
  adh: string;
  cag: string;
  achat: string;
  total: string;
}

export function allocationTotals(lines: readonly AllocationLine[]): AllocationTotals {
  const sum = (f: (l: AllocationLine) => number) =>
    centsToDecimal(lines.reduce((s, l) => s + f(l), 0));
  return {
    count: lines.length,
    don: sum((l) => l.donCents),
    adh: sum((l) => l.adhCents),
    cag: sum((l) => l.cagCents),
    achat: sum((l) => l.achatCents),
    total: sum((l) => l.totalCents),
  };
}

/** The labels of the columns, as the template of the accountants words them. */
export const ALLOCATION_COLUMN_LABELS = {
  date: 'Date d’opération',
  label: 'Libellé Ticket',
  who: 'Nom Adhérent (ou adhérent de passage)',
  mode: 'Mode de règlement',
  don: 'Montant DON',
  adh: 'Montant ADHESION (ou adhésion de passage)',
  cag: 'Montant Versement sur CAGNOTTE',
  achat: 'Montant ACHAT',
  total: 'Total Montant Ticket',
  check: 'Contrôle (I = E+F+H)',
  note: 'Remarque',
} as const;
