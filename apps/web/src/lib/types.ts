import type {
  MemberPaymentMethod,
  MemberPaymentPurpose,
  MemberStatus,
  PaymentMethod,
  ProductKind,
  ProductStatus,
  Quality,
  RoleCode,
  SaleCondition,
  SaleMode,
  Unit,
  WalletEntryKind,
} from '@episoft/shared';

// Shapes returned by the API for the back-office pages.

export interface MemberListItem {
  id: string;
  number: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: MemberStatus;
  householdId: string | null;
  householdNumber: number | null;
  isReferent: boolean | null;
  balance: string | null;
  membershipEnd: string | null;
}

export interface MemberDetail {
  id: string;
  number: number;
  householdId: string | null;
  lastName: string;
  firstName: string;
  street: string | null;
  postcode: string | null;
  communeId: string | null;
  phone: string | null;
  email: string | null;
  status: MemberStatus;
  publicVisible: boolean;
  newsletter: boolean;
  newsletterOptInAt: string | null;
  username: string | null;
  hasPassword: boolean;
  hasQr: boolean;
  roles: RoleCode[];
  createdAt: string;
  updatedAt: string;
}

export interface Commune {
  id: string;
  postcode: string;
  name: string;
}

export interface MembershipTypeRow {
  id: string;
  code: string;
  label: string;
  price: string;
  durationMonths: number;
  productId: string | null;
  active: boolean;
  sort: number;
}

export interface HouseholdDetail {
  id: string;
  number: number;
  referentMemberId: string | null;
  transferReference: string | null;
  notes: string | null;
  updatedAt: string;
  balance: string;
  members: {
    id: string;
    number: number;
    firstName: string;
    lastName: string;
    status: MemberStatus;
    email: string | null;
    phone: string | null;
  }[];
  memberships: {
    id: string;
    type: string;
    startDate: string;
    endDate: string;
    amount: string;
    saleId: string | null;
    cancelledAt: string | null;
  }[];
  wallet: {
    id: string;
    at: string;
    amount: string;
    kind: WalletEntryKind;
    paymentMethod: PaymentMethod | null;
    saleId: string | null;
    saleNumber: string | null;
    comment: string | null;
    forced: boolean;
    cancellable: boolean;
    byName: string | null;
  }[];
  payments: {
    id: string;
    date: string;
    amount: string;
    purpose: MemberPaymentPurpose;
    method: MemberPaymentMethod | null;
    comment: string | null;
  }[];
}

export interface SaleListItem {
  id: string;
  number: string;
  provisionalNumber: string | null;
  soldAt: string;
  total: string;
  status: 'COMPLETED' | 'CANCELLED';
  cancelsSaleId: string | null;
  memberName: string | null;
  memberId: string | null;
  sessionId: string;
  warnings: { code: string; message: string }[] | null;
  payments: { method: PaymentMethod; amount: string }[];
}

export interface SaleDetail extends Omit<SaleListItem, 'payments'> {
  cashierName: string | null;
  emailSentAt: string | null;
  cancelledBy: { id: string; number: string } | null;
  lines: {
    id: string;
    lineNo: number;
    label: string;
    qty: string;
    unitPrice: string;
    catalogPrice: string | null;
    discount: string;
    lineTotal: string;
  }[];
  payments: {
    id: string;
    method: PaymentMethod;
    amount: string;
    tendered: string | null;
    change: string | null;
    changeToWallet: boolean;
  }[];
}

export interface ProductListItem {
  id: string;
  code: string;
  name: string;
  kind: ProductKind;
  status: ProductStatus;
  salePrice: string;
  stockQty: string;
  minStock: string | null;
  saleMode: SaleMode;
  unit: Unit | null;
  labelPending: boolean;
  categoryName: string | null;
  supplierName: string | null;
  imageId: string | null;
}

export interface ProductDetail {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: ProductKind;
  saleMode: SaleMode;
  unitQty: string | null;
  unit: Unit | null;
  saleCondition: SaleCondition;
  categoryId: string | null;
  supplierId: string | null;
  supplierRef: string | null;
  qualities: Quality[];
  vatRate: string;
  status: ProductStatus;
  purchasePriceExcl: string | null;
  purchasePriceIncl: string | null;
  salePrice: string;
  minStock: string | null;
  stockQty: string;
  labelPending: boolean;
  posTabId: string | null;
  posSort: number;
  posLabel: string | null;
  imageId: string | null;
  eans: string[];
  hasSales: boolean;
  priceHistory: {
    id: string;
    at: string;
    purchasePriceExcl: string | null;
    salePrice: string;
    source: string;
  }[];
  updatedAt: string;
}

export interface CatalogRefs {
  universes: { id: string; code: string; name: string; sort: number }[];
  categories: { id: string; universeId: string; code: string; name: string; sort: number }[];
  suppliers: { id: string; code: string; name: string; active: boolean }[];
  posTabs: { id: string; name: string; sort: number; active: boolean }[];
}
