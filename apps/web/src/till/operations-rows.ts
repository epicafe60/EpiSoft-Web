import {
  decimalToCents,
  DONATION_PRODUCT_CODE,
  lineTotalCents,
  parseQtyToMilli,
  saleOperationAmounts,
  sortOperations,
  centsToDecimal,
  type OperationRow,
  type SnapshotMember,
  type SnapshotMembershipType,
  type SnapshotProduct,
} from '@episoft/shared';
import type { OutboxEntry } from './db';

// The operations of the till as the till itself knows them, from its queue: what works without the
// network. The server's own list (GET /pos/operations) is the base when the till is online.

export type OperationScope = { sessionId: string } | { day: string };

/** A row from the till's queue, with whether the cashier has put a refused ticket aside. */
export type LocalOperationRow = OperationRow & { acknowledged: boolean };

export interface LocalOperationsInput {
  entries: readonly OutboxEntry[];
  products: readonly Pick<SnapshotProduct, 'id' | 'code'>[];
  membershipTypes: readonly Pick<SnapshotMembershipType, 'productId'>[];
  members: readonly Pick<
    SnapshotMember,
    'id' | 'firstName' | 'lastName' | 'householdId' | 'number'
  >[];
  scope: OperationScope;
}

const parisDay = (iso: string) =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

const inScope = (scope: OperationScope, sessionId: string, at: string) =>
  'sessionId' in scope ? sessionId === scope.sessionId : parisDay(at) === scope.day;

/** The tickets this till has cancelled (a cancellation refused by the server does not count). */
export function cancelledSaleIds(entries: readonly OutboxEntry[]): Set<string> {
  return new Set(
    entries.flatMap((e) =>
      e.op.kind === 'SALE_CANCEL' && e.status !== 'REJECTED' ? [e.op.payload.saleId] : [],
    ),
  );
}

const syncOf = (e: OutboxEntry): OperationRow['sync'] =>
  e.status === 'PENDING' ? 'PENDING' : e.status === 'REJECTED' ? 'REJECTED' : 'SENT';

/** The tickets and the top-ups of the till's queue (R-VTE-12, R-CAG-05, R-OFF-02). */
export function localOperations(i: LocalOperationsInput): LocalOperationRow[] {
  const cancelled = cancelledSaleIds(i.entries);
  const donationIds = new Set(
    i.products.filter((p) => p.code === DONATION_PRODUCT_CODE).map((p) => p.id),
  );
  const membershipIds = new Set(
    i.membershipTypes.flatMap((m) => (m.productId ? [m.productId] : [])),
  );
  const nameOf = (id: string | null | undefined) => {
    const m = i.members.find((x) => x.id === id);
    return m ? `${m.firstName} ${m.lastName}` : null;
  };
  const rows: LocalOperationRow[] = [];
  for (const e of i.entries) {
    const base = {
      origin: 'LOCAL' as const,
      deviceName: null,
      sync: syncOf(e),
      error: e.status === 'REJECTED' ? e.lastError : null,
      acknowledged: !!e.acknowledged,
    };
    if (e.op.kind === 'SALE') {
      const p = e.op.payload;
      if (!inScope(i.scope, p.sessionId, p.soldAt)) continue;
      const a = saleOperationAmounts({
        lines: p.lines.map((l) => ({
          productId: l.productId,
          totalCents: lineTotalCents({
            qtyMilli: parseQtyToMilli(l.qty) ?? 0,
            unitPriceCents: decimalToCents(l.unitPrice),
            discountCents: decimalToCents(l.discount),
          }),
        })),
        payments: p.payments.map((x) => ({
          method: x.method,
          amountCents: decimalToCents(x.amount),
          changeCents: x.change ? decimalToCents(x.change) : null,
          changeToWallet: x.changeToWallet,
        })),
        donationProductIds: donationIds,
        membershipProductIds: membershipIds,
      });
      rows.push({
        ...base,
        id: e.id,
        type: 'SALE',
        at: p.soldAt,
        number: e.result?.number ?? p.provisionalNumber,
        cashierName: nameOf(p.cashierId),
        memberName: nameOf(p.memberId),
        payments: p.payments.map((x) => ({ method: x.method, amount: x.amount })),
        total: p.total,
        donation: centsToDecimal(a.donationCents),
        membership: centsToDecimal(a.membershipCents),
        wallet: centsToDecimal(a.walletCents),
        walletCash: centsToDecimal(a.walletCashCents),
        cancelled: cancelled.has(e.id),
      });
    } else if (e.op.kind === 'WALLET_TOPUP') {
      const p = e.op.payload;
      if (!inScope(i.scope, p.sessionId, p.at)) continue;
      // The snapshot does not say who is the referent of a household: its first member stands for it.
      const who = i.members
        .filter((m) => m.householdId === p.householdId)
        .sort((a, b) => a.number - b.number)[0];
      rows.push({
        ...base,
        id: e.id,
        type: 'TOPUP',
        at: p.at,
        number: null,
        cashierName: nameOf(p.cashierId),
        memberName: who ? `${who.firstName} ${who.lastName}` : null,
        payments: [{ method: p.method, amount: p.amount }],
        total: p.amount,
        donation: '0.00',
        membership: '0.00',
        wallet: p.amount,
        walletCash: '0.00',
        cancelled: false,
      });
    }
  }
  return rows;
}

/**
 * Online, the server's rows are the base; the till adds what the server does not have yet (tickets
 * and top-ups waiting to be sent, or refused). Offline, only the till's own rows. A ticket this
 * till has cancelled shows as cancelled even before the server knows.
 */
export function mergeOperations(
  server: readonly OperationRow[] | undefined,
  local: readonly LocalOperationRow[],
  cancelledIds: ReadonlySet<string>,
): LocalOperationRow[] {
  if (!server) return sortOperations(local) as LocalOperationRow[];
  const known = new Set(server.map((r) => r.id));
  const fromServer: LocalOperationRow[] = server.map((r) => ({
    ...r,
    cancelled: r.cancelled || (r.type === 'SALE' && cancelledIds.has(r.id)),
    acknowledged: false,
  }));
  const pending = local.filter((r) => r.sync !== 'SENT' && !known.has(r.id));
  return sortOperations([...fromServer, ...pending]) as LocalOperationRow[];
}
