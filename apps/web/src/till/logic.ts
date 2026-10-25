import {
  centsToDecimal,
  decimalToCents,
  lineTotalCents,
  milliToDecimal,
  parseQtyToMilli,
  type PaymentMethod,
  type PendingWalletMove,
  type SnapshotProduct,
  type SyncOp,
} from '@episoft/shared';
import type { Draft, DraftLine, OutboxEntry } from './db';

/** A name for a till that declares itself: POSTE- and four letters or digits. */
export function newDeviceName(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to mistake
  return `POSTE-${Array.from(random(4), (b) => alphabet[b % alphabet.length]).join('')}`;
}

export function lineCents(l: DraftLine): number {
  return lineTotalCents(l);
}

export function draftTotalCents(d: Pick<Draft, 'lines'>): number {
  return d.lines.reduce((s, l) => s + lineCents(l), 0);
}

/**
 * R-VTE-04 / R-VTE-05: adds a product. A product already on the ticket at the same price
 * and without discount has its quantity increased instead of a new line.
 */
export function addProduct(lines: DraftLine[], p: SnapshotProduct, qtyMilli: number): DraftLine[] {
  const price = decimalToCents(p.salePrice);
  const i = lines.findIndex(
    (l) => l.productId === p.id && l.unitPriceCents === price && l.discountCents === 0,
  );
  if (i >= 0) {
    return lines.map((l, j) => (j === i ? { ...l, qtyMilli: l.qtyMilli + qtyMilli } : l));
  }
  return [
    ...lines,
    {
      productId: p.id,
      label: p.posLabel || p.name,
      qtyMilli,
      unitPriceCents: price,
      catalogPriceCents: price,
      discountCents: 0,
    },
  ];
}

/**
 * A refused ticket entered again: its lines and its member go back into a new draft, at the
 * price that was charged, so the cashier checks and pays it again.
 */
export function linesFromSale(payload: Extract<SyncOp, { kind: 'SALE' }>['payload']): DraftLine[] {
  return payload.lines.map((l) => ({
    productId: l.productId,
    label: l.label,
    qtyMilli: parseQtyToMilli(l.qty) ?? 1000,
    unitPriceCents: decimalToCents(l.unitPrice),
    catalogPriceCents: decimalToCents(l.catalogPrice ?? l.unitPrice),
    discountCents: decimalToCents(l.discount),
  }));
}

export interface PaymentDraft {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents?: number;
  changeCents?: number;
  changeToWallet?: boolean;
}

export function saleOp(args: {
  id: string;
  deviceSeq: number;
  draft: Draft;
  sessionId: string;
  cashierId: string;
  provisionalNumber: string;
  payments: PaymentDraft[];
  emailReceipt: boolean;
  overdraftForcedBy: string | null;
  now: Date;
}): SyncOp {
  const { draft } = args;
  return {
    kind: 'SALE',
    id: args.id,
    deviceSeq: args.deviceSeq,
    payload: {
      sessionId: args.sessionId,
      cashierId: args.cashierId,
      memberId: draft.memberId,
      preorderId: draft.preorderId ?? null,
      soldAt: args.now.toISOString(),
      provisionalNumber: args.provisionalNumber,
      lines: draft.lines.map((l) => ({
        productId: l.productId,
        label: l.label,
        qty: milliToDecimal(l.qtyMilli),
        unitPrice: centsToDecimal(l.unitPriceCents),
        catalogPrice: centsToDecimal(l.catalogPriceCents),
        discount: centsToDecimal(l.discountCents),
      })),
      payments: args.payments.map((p) => ({
        method: p.method,
        amount: centsToDecimal(p.amountCents),
        tendered: p.tenderedCents !== undefined ? centsToDecimal(p.tenderedCents) : null,
        change: p.changeCents !== undefined ? centsToDecimal(p.changeCents) : null,
        changeToWallet: p.changeToWallet ?? false,
      })),
      total: centsToDecimal(draftTotalCents(draft)),
      emailReceipt: args.emailReceipt,
      walletOverdraftForcedBy: args.overdraftForcedBy,
    },
  };
}

/**
 * R-OFF-04: cagnotte moves made on this device that the last snapshot does not include yet:
 * operations still pending, or answered after that snapshot was taken.
 */
export function pendingWalletMoves(
  outbox: readonly OutboxEntry[],
  lastSnapshotAt: string | null,
  householdOfMember: (memberId: string) => string | null,
): PendingWalletMove[] {
  const moves: PendingWalletMove[] = [];
  for (const e of outbox) {
    if (e.status === 'REJECTED') continue;
    const reflected =
      e.status === 'DONE' &&
      e.syncedAt !== null &&
      lastSnapshotAt !== null &&
      e.syncedAt <= lastSnapshotAt;
    if (reflected) continue;
    const op = e.op;
    if (op.kind === 'SALE' && op.payload.memberId) {
      const householdId = householdOfMember(op.payload.memberId);
      if (!householdId) continue;
      for (const p of op.payload.payments) {
        if (p.method === 'WALLET')
          moves.push({ householdId, amountCents: -decimalToCents(p.amount) });
        if (p.changeToWallet && p.change)
          moves.push({ householdId, amountCents: decimalToCents(p.change) });
      }
    }
    if (op.kind === 'WALLET_TOPUP')
      moves.push({
        householdId: op.payload.householdId,
        amountCents: decimalToCents(op.payload.amount),
      });
  }
  return moves;
}

/** R-OFF-03: exponential back-off between push attempts, 2 s to 2 min. */
export function backoffMs(failures: number): number {
  return Math.min(120_000, 2000 * 2 ** Math.max(0, failures - 1));
}
