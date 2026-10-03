import { z } from 'zod';
import {
  MEMBER_PAYMENT_METHODS,
  type ProductKind,
  type ProductStatus,
  type SaleMode,
  type Unit,
} from './catalog';
import type { MemberStatus } from './api';
import { PAYMENT_METHODS } from './pos';

// Till ↔ server contract (spec §8.3). Operations are created on the device, stored in
// its outbox, and pushed in deviceSeq order. The operation id is the idempotency key.

/** Decimal string with up to 2 decimals, e.g. "12.50" or "-3.00". */
const amount = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Montant invalide.');
const quantity = z.string().regex(/^-?\d+(\.\d{1,3})?$/, 'Quantité invalide.');
const isoDateTime = z.string().datetime({ offset: true });

const base = {
  id: z.string().uuid(),
  deviceSeq: z.number().int().positive(),
};

export const saleLineSchema = z.object({
  productId: z.string().uuid(),
  label: z.string().min(1).max(200),
  qty: quantity,
  /** Prices at the till have 2 decimals, like the catalogue. */
  unitPrice: amount,
  catalogPrice: amount.nullable(),
  discount: amount,
});
export type SaleLinePayload = z.infer<typeof saleLineSchema>;

export const salePaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount,
  tendered: amount.nullable().optional(),
  change: amount.nullable().optional(),
  changeToWallet: z.boolean().optional(),
});
export type SalePaymentPayload = z.infer<typeof salePaymentSchema>;

export const saleOpSchema = z.object({
  ...base,
  kind: z.literal('SALE'),
  payload: z.object({
    sessionId: z.string().uuid(),
    cashierId: z.string().uuid(),
    memberId: z.string().uuid().nullable(),
    soldAt: isoDateTime,
    provisionalNumber: z.string().max(40),
    lines: z.array(saleLineSchema).min(1).max(500),
    payments: z.array(salePaymentSchema).min(1).max(20),
    total: amount,
    emailReceipt: z.boolean().default(false),
    /** R-CAG-04: ADHERENTS user who authorised an overdraft beyond the limit. */
    walletOverdraftForcedBy: z.string().uuid().nullable().optional(),
  }),
});

export const saleCancelOpSchema = z.object({
  ...base,
  kind: z.literal('SALE_CANCEL'),
  payload: z.object({
    /** Id of the cancellation sale, generated on the device. */
    cancelSaleId: z.string().uuid(),
    saleId: z.string().uuid(),
    sessionId: z.string().uuid(),
    cashierId: z.string().uuid(),
    at: isoDateTime,
    provisionalNumber: z.string().max(40),
    reason: z.string().max(300).optional(),
  }),
});

export const walletTopupOpSchema = z.object({
  ...base,
  kind: z.literal('WALLET_TOPUP'),
  payload: z.object({
    sessionId: z.string().uuid(),
    cashierId: z.string().uuid(),
    householdId: z.string().uuid(),
    amount,
    method: z.enum(MEMBER_PAYMENT_METHODS),
    at: isoDateTime,
    emailReceipt: z.boolean().default(false),
  }),
});

export const sessionOpenOpSchema = z.object({
  ...base,
  kind: z.literal('SESSION_OPEN'),
  payload: z.object({
    /** The session id, generated on the device so sales can be made offline (R-SES-01). */
    sessionId: z.string().uuid(),
    openedBy: z.string().uuid(),
    openedAt: isoDateTime,
    openingFloat: amount,
  }),
});

export const syncOpSchema = z.discriminatedUnion('kind', [
  sessionOpenOpSchema,
  saleOpSchema,
  saleCancelOpSchema,
  walletTopupOpSchema,
]);
export type SyncOp = z.infer<typeof syncOpSchema>;
export type SyncOpKind = SyncOp['kind'];

export const syncPushSchema = z.object({
  deviceId: z.string().uuid(),
  ops: z.array(syncOpSchema).min(1).max(200),
});

export interface SyncWarning {
  code: string;
  message: string;
}

export interface SyncResult {
  id: string;
  status: 'OK' | 'REJECTED';
  /** Final number of a sale (R-SYNC-05). */
  number?: string;
  warnings: SyncWarning[];
  error?: string;
}

// --- Snapshot (R-OFF-02) --------------------------------------------------------

export interface SnapshotProduct {
  id: string;
  code: string;
  name: string;
  kind: ProductKind;
  saleMode: SaleMode;
  unit: Unit | null;
  unitQty: string | null;
  status: ProductStatus;
  salePrice: string;
  vatRate: string;
  eans: string[];
  posTabId: string | null;
  posSort: number;
  posLabel: string | null;
  imageId: string | null;
  /** Membership type sold by this product (R-ADH-05), if any. */
  membershipTypeId: string | null;
}

export interface SnapshotMember {
  id: string;
  number: number;
  firstName: string;
  lastName: string;
  householdId: string | null;
  status: MemberStatus;
  /** SHA-256 of the badge token only (R-SYNC-06). */
  qrTokenHash: string | null;
  isCashier: boolean;
  hasEmail: boolean;
}

export interface SnapshotHousehold {
  id: string;
  number: number;
  balance: string;
  membershipEnd: string | null;
}

export interface SnapshotMembershipType {
  id: string;
  code: string;
  label: string;
  price: string;
  durationMonths: number;
  productId: string | null;
  active: boolean;
}

export interface SnapshotPosTab {
  id: string;
  name: string;
  sort: number;
  active: boolean;
}

export interface TillSettings {
  overdraftLimit: string;
  sellToNonMembers: boolean;
  defaultFloat: string;
  allowTransfer: boolean;
  discountsEnabled: boolean;
  membershipExpiredBlocking: boolean;
}

export interface Snapshot {
  /** Pass back as `since` for the next incremental refresh. */
  cursor: string;
  full: boolean;
  serverTime: string;
  products: SnapshotProduct[];
  members: SnapshotMember[];
  /** Always complete: balances and membership ends are small and must be exact. */
  households: SnapshotHousehold[];
  membershipTypes: SnapshotMembershipType[];
  posTabs: SnapshotPosTab[];
  settings: TillSettings;
}
