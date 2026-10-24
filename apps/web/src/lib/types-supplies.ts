import type { ProductStatus, SupplierPaymentMethod, Unit } from '@episoft/shared';

// Shapes returned by the lot 2 API.

export type OrderStatus = 'DRAFT' | 'SENT' | 'PARTIAL' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Brouillon',
  SENT: 'Envoyée',
  PARTIAL: 'Partiellement reçue',
  RECEIVED: 'Reçue',
  CLOSED: 'Soldée',
  CANCELLED: 'Annulée',
};

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  sendsPo: boolean;
  products: number;
  toPay: string;
}

export interface SupplierDetail {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  street: string | null;
  postcode: string | null;
  communeId: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  priceListUrl: string | null;
  active: boolean;
  publicNotes: string | null;
  privateNotes: string | null;
  referentMemberId: string | null;
  sendsPo: boolean;
  accountNumber: string | null;
  minOrderAmount: string | null;
  paymentTermsDays: number;
  deliveryDay: string | null;
  updatedAt: string;
  products: {
    id: string;
    code: string;
    name: string;
    status: ProductStatus;
    stockQty: string;
    minStock: string | null;
    purchasePriceExcl: string | null;
    salePrice: string;
    supplierRef: string | null;
  }[];
  orders: { id: string; number: string; date: string; status: OrderStatus; totalIncl: string }[];
  invoices: {
    id: string;
    pieceRef: string;
    date: string;
    dueDate: string;
    totalIncl: string;
    status: 'TO_PAY' | 'PAID';
  }[];
  receipts: { id: string; number: string; date: string; orderId: string | null }[];
}

export interface OrderRow {
  id: string;
  number: string;
  date: string;
  status: OrderStatus;
  supplierId: string;
  supplierName: string;
  totalExcl: string;
  totalVat: string;
  totalIncl: string;
  comment: string | null;
}

export interface OrderDetail {
  id: string;
  number: string;
  date: string;
  status: OrderStatus;
  comment: string | null;
  totalExcl: string;
  totalVat: string;
  totalIncl: string;
  sentAt: string | null;
  sentTo: string | null;
  supplierId: string;
  supplier: {
    id: string;
    code: string;
    name: string;
    email: string | null;
    minOrderAmount: string | null;
  } | null;
  lines: {
    id: string;
    productId: string;
    code: string;
    name: string;
    supplierRef: string | null;
    qtyOrdered: string;
    qtyReceived: string;
    unitPriceExcl: string;
    vatRate: string;
    salePrice: string;
    /** The product's last known purchase price (what the receipt is checked against). */
    purchasePriceExcl: string | null;
    stockQty: string;
    totalExcl: string;
  }[];
  receipts: { id: string; number: string; date: string; receivedByName?: string | null }[];
}

export interface InvoiceRow {
  id: string;
  supplierId: string;
  supplierName: string;
  pieceRef: string;
  date: string;
  dueDate: string;
  totalExcl: string;
  totalVat: string;
  totalIncl: string;
  status: 'TO_PAY' | 'PAID';
  paymentMethod: SupplierPaymentMethod | null;
  paidAt: string | null;
  hasDocument: boolean;
}

export interface InvoiceDetail {
  id: string;
  supplierId: string;
  pieceRef: string;
  date: string;
  dueDate: string;
  totalExcl: string;
  totalVat: string;
  totalIncl: string;
  status: 'TO_PAY' | 'PAID';
  paymentMethod: SupplierPaymentMethod | null;
  paidAt: string | null;
  documentMediaId: string | null;
  comment: string | null;
  receipts: { id: string; number: string; date: string }[];
  receivedTotal: string;
  difference: string | null;
  duplicates: { id: string; pieceRef: string; date: string; totalIncl: string }[];
}

export interface InventoryRow {
  id: string;
  label: string;
  status: 'OPEN' | 'VALIDATED' | 'CANCELLED';
  openedAt: string;
  validatedAt: string | null;
  lines: number;
  counted: number;
}

export interface InventoryDetail {
  id: string;
  label: string;
  status: 'OPEN' | 'VALIDATED' | 'CANCELLED';
  openedAt: string;
  validatedAt: string | null;
  lines: {
    productId: string;
    code: string;
    name: string;
    unit: Unit | null;
    saleMode: 'UNIT' | 'WEIGHT' | 'VOLUME';
    categoryName: string | null;
    theoreticalQty: string;
    countedQty: string | null;
    countedAt: string | null;
    adjustment: string | null;
    /** Purchase price excl. VAT frozen when the inventory was opened (values the gaps). */
    unitCostExcl: string | null;
    eans: string[];
  }[];
}

export interface InventoryReport {
  session: {
    id: string;
    label: string;
    status: string;
    openedAt: string;
    validatedAt: string | null;
  };
  rows: {
    productId: string;
    code: string;
    name: string;
    theoreticalQty: string;
    countedQty: string | null;
    adjustment: string;
    valueExcl: string;
    valueIncl: string;
  }[];
  totalExcl: string;
  totalIncl: string;
  uncounted: number;
}

export interface MovementRow {
  id: string;
  at: string;
  qty: string;
  kind: string;
  unitCost: string | null;
  sourceType: string | null;
  sourceId: string | null;
  comment: string | null;
  byName: string | null;
  balance: string;
}

export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  SALE: 'Vente',
  SALE_CANCEL: 'Annulation de vente',
  PURCHASE_IN: 'Entrée achat',
  SUPPLIER_RETURN: 'Retour fournisseur',
  INVENTORY: 'Inventaire',
  LOSS: 'Perte',
  CORRECTION: 'Correction',
  INITIAL: 'Stock initial',
};
