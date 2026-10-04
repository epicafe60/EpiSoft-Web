import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import {
  MEMBER_PAYMENT_PURPOSES,
  MEMBER_STATUSES,
  PAYMENT_METHODS,
  PRICE_SOURCES,
  PREORDER_STATUSES,
  PRODUCT_KINDS,
  PRODUCT_STATUSES,
  SALE_CONDITIONS,
  SALE_MODES,
  STOCK_MOVEMENT_KINDS,
  UNITS,
  WALLET_ENTRY_KINDS,
} from '@episoft/shared';

// Target data model, spec §6. Tables of lots 0 to 3; later lots add theirs here.

export const app = pgSchema('app');

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tz('created_at').notNull().defaultNow();
const updatedAt = () =>
  tz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const memberStatus = app.enum('member_status', MEMBER_STATUSES);

// --- Reference data -------------------------------------------------------

export const region = app.table('region', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
});

export const commune = app.table(
  'commune',
  {
    id: id(),
    postcode: text('postcode').notNull(),
    name: text('name').notNull(),
    regionId: uuid('region_id').references(() => region.id),
    legacyCommuneId: integer('legacy_communeid').unique(),
  },
  (t) => [index('commune_postcode_idx').on(t.postcode)],
);

// --- Members and households (§6.2) ----------------------------------------

export const household = app.table(
  'household',
  {
    id: id(),
    number: integer('number').notNull().unique().generatedByDefaultAsIdentity(),
    referentMemberId: uuid('referent_member_id').references((): AnyPgColumn => member.id, {
      onDelete: 'set null',
    }),
    transferReference: text('transfer_reference'),
    notes: text('notes'),
    legacyAdhid: integer('legacy_adhid').unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('household_transfer_reference_uq')
      .on(t.transferReference)
      .where(sql`${t.transferReference} is not null`),
  ],
);

export const member = app.table(
  'member',
  {
    id: id(),
    number: integer('number').notNull().unique().generatedByDefaultAsIdentity(),
    householdId: uuid('household_id').references(() => household.id),
    lastName: text('last_name').notNull(),
    firstName: text('first_name').notNull(),
    street: text('street'),
    postcode: text('postcode'),
    communeId: uuid('commune_id').references(() => commune.id),
    phone: text('phone'),
    email: text('email'),
    status: memberStatus('status').notNull().default('NEW'),
    publicVisible: boolean('public_visible').notNull().default(false),
    newsletterOptInAt: tz('newsletter_opt_in_at'),
    username: text('username'),
    passwordHash: text('password_hash'),
    qrTokenHash: text('qr_token_hash'),
    legacyMbreid: integer('legacy_mbreid').unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('member_username_uq')
      .on(sql`lower(${t.username})`)
      .where(sql`${t.username} is not null`),
    uniqueIndex('member_email_uq')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    uniqueIndex('member_qr_token_hash_uq')
      .on(t.qrTokenHash)
      .where(sql`${t.qrTokenHash} is not null`),
    index('member_household_idx').on(t.householdId),
    check(
      'member_names_not_blank',
      sql`btrim(${t.lastName}) <> '' and btrim(${t.firstName}) <> ''`,
    ),
  ],
);

export const role = app.table('role', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
});

export const userRole = app.table(
  'user_role',
  {
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    roleCode: text('role_code')
      .notNull()
      .references(() => role.code),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.roleCode] })],
);

// --- Authentication (§4.1) ------------------------------------------------

/** Server-side sessions. `id` is the SHA-256 of the cookie token, never the token itself. */
export const session = app.table(
  'session',
  {
    id: text('id').primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: tz('expires_at').notNull(),
    lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Admin impersonation: the member the administrator is acting as (audited). */
    actingAsId: uuid('acting_as_id').references(() => member.id, { onDelete: 'set null' }),
    loginLogId: uuid('login_log_id'),
  },
  (t) => [index('session_member_idx').on(t.memberId)],
);

/** R-AUTH-07, replaces `epidatas.logins`. Failed attempts are kept for R-AUTH-03. */
export const loginLog = app.table(
  'login_log',
  {
    id: id(),
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'set null' }),
    username: text('username'),
    at: tz('at').notNull().defaultNow(),
    device: text('device'),
    ip: text('ip'),
    success: boolean('success').notNull(),
    logoutAt: tz('logout_at'),
    legacyLogid: integer('legacy_logid').unique(),
  },
  (t) => [
    index('login_log_username_at_idx').on(sql`lower(${t.username})`, t.at),
    index('login_log_member_at_idx').on(t.memberId, t.at),
  ],
);

/** R-AUTH-02. `id` is the SHA-256 of the token sent by e-mail. */
export const passwordResetToken = app.table('password_reset_token', {
  id: text('id').primaryKey(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => member.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  expiresAt: tz('expires_at').notNull(),
  usedAt: tz('used_at'),
});

// --- Cross-cutting (§6.2 "Transverse") ------------------------------------

export const setting = app.table('setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => member.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

export const auditLog = app.table(
  'audit_log',
  {
    id: id(),
    at: tz('at').notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => member.id, { onDelete: 'set null' }),
    /** Set while an administrator is impersonating this member: actorId stays the real person. */
    onBehalfOfId: uuid('on_behalf_of_id').references(() => member.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
    index('audit_log_actor_idx').on(t.actorId, t.at),
  ],
);

export const emailStatus = app.enum('email_status', ['PENDING', 'SENT', 'FAILED']);

export const emailOutbox = app.table(
  'email_outbox',
  {
    id: id(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text'),
    attachments: jsonb('attachments'),
    status: emailStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
    sentAt: tz('sent_at'),
  },
  (t) => [
    index('email_outbox_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

// ===========================================================================
// Lot 1
// ===========================================================================

/** Money: numeric(12,2), returned as a decimal string. */
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });
/** Purchase and unit prices keep 4 decimals (§6.3). */
const price4 = (name: string) => numeric(name, { precision: 12, scale: 4 });
const qty = (name: string) => numeric(name, { precision: 12, scale: 3 });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

// --- Catalogue (§6.2) -----------------------------------------------------

export const productKind = app.enum('product_kind', PRODUCT_KINDS);
export const saleMode = app.enum('sale_mode', SALE_MODES);
export const unitEnum = app.enum('unit', UNITS);
export const saleCondition = app.enum('sale_condition', SALE_CONDITIONS);
export const productStatus = app.enum('product_status', PRODUCT_STATUSES);
export const priceSource = app.enum('price_source', PRICE_SOURCES);
export const stockMovementKind = app.enum('stock_movement_kind', STOCK_MOVEMENT_KINDS);

export const universe = app.table('universe', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
});

/** The shelf ("rayon"). */
export const category = app.table(
  'category',
  {
    id: id(),
    universeId: uuid('universe_id')
      .notNull()
      .references(() => universe.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
    /** Q6: revenue account of the shelf; null means the default sales account. */
    salesAccountNumber: text('sales_account_number'),
  },
  (t) => [uniqueIndex('category_universe_code_uq').on(t.universeId, t.code)],
);

/** Lot 1 keeps the supplier minimal; lot 2 completes it (§4.7). */
export const supplier = app.table('supplier', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  contact: text('contact'),
  street: text('street'),
  postcode: text('postcode'),
  communeId: uuid('commune_id').references(() => commune.id),
  phone: text('phone'),
  email: text('email'),
  website: text('website'),
  priceListUrl: text('price_list_url'),
  active: boolean('active').notNull().default(true),
  publicNotes: text('public_notes'),
  privateNotes: text('private_notes'),
  referentMemberId: uuid('referent_member_id').references(() => member.id, {
    onDelete: 'set null',
  }),
  sendsPo: boolean('sends_po').notNull().default(false),
  /** Supplier account (401…). Becomes a foreign key to `account` in lot 3. */
  accountNumber: text('account_number'),
  minOrderAmount: money('min_order_amount'),
  /** Days between the invoice date and its due date (R-FAC-01). */
  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  deliveryDay: text('delivery_day'),
  legacyFnrcode: text('legacy_fnrcode').unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Images and attachments (replaces `prodimg`). */
export const media = app.table('media', {
  id: id(),
  mime: text('mime').notNull(),
  bytes: bytea('bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: createdAt(),
});

/** Till button tabs (replaces `imgtabs`, R-VTE-14). */
export const posTab = app.table('pos_tab', {
  id: id(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  legacyTabid: integer('legacy_tabid').unique(),
  updatedAt: updatedAt(),
});

export const product = app.table(
  'product',
  {
    id: id(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    kind: productKind('kind').notNull().default('GOODS'),
    saleMode: saleMode('sale_mode').notNull().default('UNIT'),
    unitQty: qty('unit_qty'),
    unit: unitEnum('unit'),
    saleCondition: saleCondition('sale_condition').notNull().default('ON_SITE'),
    categoryId: uuid('category_id').references(() => category.id),
    supplierId: uuid('supplier_id').references(() => supplier.id),
    supplierRef: text('supplier_ref'),
    qualities: text('qualities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    status: productStatus('status').notNull().default('ACTIVE'),
    purchasePriceExcl: price4('purchase_price_excl'),
    purchasePriceIncl: price4('purchase_price_incl'),
    salePrice: money('sale_price').notNull().default('0'),
    minStock: qty('min_stock'),
    /** Cache of the sum of stock_movement.qty, updated in the same transaction (principle 6). */
    stockQty: qty('stock_qty').notNull().default('0'),
    labelPending: boolean('label_pending').notNull().default(false),
    posTabId: uuid('pos_tab_id').references(() => posTab.id, { onDelete: 'set null' }),
    posSort: integer('pos_sort').notNull().default(0),
    posLabel: text('pos_label'),
    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    createdOn: date('created_on'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('product_name_idx').on(t.name),
    index('product_updated_idx').on(t.updatedAt),
    check('product_sale_price_positive', sql`${t.salePrice} >= 0`),
  ],
);

export const productBarcode = app.table(
  'product_barcode',
  {
    ean: text('ean').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
  },
  (t) => [index('product_barcode_product_idx').on(t.productId)],
);

export const priceHistory = app.table(
  'price_history',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    at: tz('at').notNull().defaultNow(),
    purchasePriceExcl: price4('purchase_price_excl'),
    purchasePriceIncl: price4('purchase_price_incl'),
    salePrice: money('sale_price').notNull(),
    source: priceSource('source').notNull(),
    by: uuid('by').references(() => member.id, { onDelete: 'set null' }),
  },
  (t) => [index('price_history_product_idx').on(t.productId, t.at)],
);

/** Stock ledger: the stock of a product is the sum of its movements (principle 6). */
export const stockMovement = app.table(
  'stock_movement',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id),
    at: tz('at').notNull().defaultNow(),
    qty: qty('qty').notNull(),
    kind: stockMovementKind('kind').notNull(),
    unitCost: price4('unit_cost'),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    comment: text('comment'),
    by: uuid('by').references(() => member.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('stock_movement_product_at_idx').on(t.productId, t.at),
    index('stock_movement_source_idx').on(t.sourceType, t.sourceId),
  ],
);

// --- Memberships, payments and cagnotte (§4.3) --------------------------------

export const paymentMethod = app.enum('payment_method', PAYMENT_METHODS);
export const memberPaymentPurpose = app.enum('member_payment_purpose', MEMBER_PAYMENT_PURPOSES);
export const walletEntryKind = app.enum('wallet_entry_kind', WALLET_ENTRY_KINDS);

/** R-ADH-01: configurable membership types. A duration of 0 months is the same day only. */
export const membershipType = app.table('membership_type', {
  id: id(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  price: money('price').notNull(),
  durationMonths: integer('duration_months').notNull(),
  /** Service product sold at the till for this membership (R-ADH-05). */
  productId: uuid('product_id')
    .unique()
    .references(() => product.id),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  updatedAt: updatedAt(),
});

/** Replaces `adhpayements` for payments made outside a sale (§6.2). */
export const memberPayment = app.table(
  'member_payment',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => household.id),
    date: date('date').notNull(),
    amount: money('amount').notNull(),
    purpose: memberPaymentPurpose('purpose').notNull(),
    /** Null only for migrated payments whose mode is unknown. */
    method: paymentMethod('method'),
    cashSessionId: uuid('cash_session_id').references((): AnyPgColumn => cashSession.id),
    saleId: uuid('sale_id').references((): AnyPgColumn => sale.id),
    /** Transfer received on the bank account (R-CPT-09). */
    bankLineId: uuid('bank_line_id').references((): AnyPgColumn => bankLine.id, {
      onDelete: 'set null',
    }),
    comment: text('comment'),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    legacyPayid: integer('legacy_payid').unique(),
  },
  (t) => [
    index('member_payment_household_idx').on(t.householdId, t.date),
    index('member_payment_session_idx').on(t.cashSessionId),
    check('member_payment_not_wallet', sql`${t.method} is distinct from 'WALLET'`),
  ],
);

export const membership = app.table(
  'membership',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => household.id),
    typeId: uuid('type_id')
      .notNull()
      .references(() => membershipType.id),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    amount: money('amount').notNull(),
    saleId: uuid('sale_id').references((): AnyPgColumn => sale.id),
    paymentId: uuid('payment_id').references(() => memberPayment.id),
    cancelledAt: tz('cancelled_at'),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    legacyAdhid: integer('legacy_adhid').unique(),
  },
  (t) => [
    index('membership_household_idx').on(t.householdId, t.endDate),
    check('membership_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/** R-CAG-01: the cagnotte is a ledger per household; the balance is the sum (R-CAG-03). */
export const walletEntry = app.table(
  'wallet_entry',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => household.id),
    at: tz('at').notNull().defaultNow(),
    amount: money('amount').notNull(),
    kind: walletEntryKind('kind').notNull(),
    paymentMethod: paymentMethod('payment_method'),
    saleId: uuid('sale_id').references((): AnyPgColumn => sale.id),
    paymentId: uuid('payment_id').references(() => memberPayment.id),
    comment: text('comment'),
    /** R-CAG-04: overdraft beyond the limit, forced by this ADHERENTS user. */
    forcedBy: uuid('forced_by').references(() => member.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    legacyPayid: integer('legacy_payid').unique(),
  },
  (t) => [
    index('wallet_entry_household_idx').on(t.householdId, t.at),
    index('wallet_entry_created_idx').on(t.createdAt),
    check('wallet_entry_amount_not_zero', sql`${t.amount} <> 0`),
    check(
      'wallet_entry_sign',
      sql`(${t.kind} in ('TOPUP', 'REFUND') and ${t.amount} > 0) or (${t.kind} = 'PURCHASE' and ${t.amount} < 0) or ${t.kind} = 'CORRECTION'`,
    ),
  ],
);

// --- Till: devices, sessions, sales (§4.4, §4.5, §8.3) -------------------------

export const cashSessionStatus = app.enum('cash_session_status', ['OPEN', 'CLOSED']);
export const saleStatus = app.enum('sale_status', ['COMPLETED', 'CANCELLED']);

export const posDevice = app.table('pos_device', {
  id: id(),
  name: text('name').notNull().unique(),
  active: boolean('active').notNull().default(true),
  lastSyncAt: tz('last_sync_at'),
  createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const cashSession = app.table(
  'cash_session',
  {
    /** Generated on the device, so a session can be opened offline. */
    id: uuid('id').primaryKey(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => posDevice.id),
    openedBy: uuid('opened_by').references(() => member.id),
    openedAt: tz('opened_at').notNull(),
    openingFloat: money('opening_float').notNull(),
    closedBy: uuid('closed_by').references(() => member.id),
    closedAt: tz('closed_at'),
    status: cashSessionStatus('status').notNull().default('OPEN'),
    /** R-CPT-08: the draft VTE entry generated at closing. */
    entryId: uuid('entry_id').references((): AnyPgColumn => entry.id, { onDelete: 'set null' }),
    /** Legacy day reconstructed by the migration (§9.1). */
    legacyDate: date('legacy_date').unique(),
  },
  (t) => [
    uniqueIndex('cash_session_one_open_per_device')
      .on(t.deviceId)
      .where(sql`${t.status} = 'OPEN'`),
    index('cash_session_opened_idx').on(t.openedAt),
  ],
);

/** R-SES-02: the closing count. Amounts are fixed at closing time. */
export const cashCount = app.table('cash_count', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => cashSession.id),
  /** Face value in cents → number of coins or notes. */
  denominations: jsonb('denominations').notNull(),
  countedCash: money('counted_cash').notNull(),
  expectedCash: money('expected_cash').notNull(),
  difference: money('difference').notNull(),
  bankDeposit: money('bank_deposit').notNull(),
  nextFloat: money('next_float').notNull(),
  chequesCount: integer('cheques_count').notNull().default(0),
  chequesTotal: money('cheques_total').notNull().default('0'),
  cardTotalDeclared: money('card_total_declared').notNull().default('0'),
  /** Totals by method and category at closing time, for the report. */
  summary: jsonb('summary').notNull(),
  comment: text('comment'),
});

export const sale = app.table(
  'sale',
  {
    /** Generated by the device: the idempotency key of the sale (§8.3). */
    id: uuid('id').primaryKey(),
    number: text('number').notNull().unique(),
    provisionalNumber: text('provisional_number'),
    deviceSeq: integer('device_seq'),
    deviceId: uuid('device_id').references(() => posDevice.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => cashSession.id),
    cashierId: uuid('cashier_id').references(() => member.id),
    memberId: uuid('member_id').references(() => member.id),
    householdId: uuid('household_id').references(() => household.id),
    soldAt: tz('sold_at').notNull(),
    total: money('total').notNull(),
    discountTotal: money('discount_total').notNull().default('0'),
    status: saleStatus('status').notNull().default('COMPLETED'),
    cancelsSaleId: uuid('cancels_sale_id').references((): AnyPgColumn => sale.id),
    hasServices: boolean('has_services').notNull().default(false),
    emailSentAt: tz('email_sent_at'),
    /** R-SYNC-04 warnings recorded when the sale was accepted. */
    warnings: jsonb('warnings'),
    createdAt: createdAt(),
    legacyRef: text('legacy_ref').unique(),
  },
  (t) => [
    index('sale_session_idx').on(t.sessionId),
    index('sale_household_idx').on(t.householdId, t.soldAt),
    index('sale_member_idx').on(t.memberId, t.soldAt),
    index('sale_sold_at_idx').on(t.soldAt),
    uniqueIndex('sale_one_cancellation')
      .on(t.cancelsSaleId)
      .where(sql`${t.cancelsSaleId} is not null`),
  ],
);

export const saleLine = app.table(
  'sale_line',
  {
    id: id(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sale.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id),
    label: text('label').notNull(),
    qty: qty('qty').notNull(),
    unitPrice: price4('unit_price').notNull(),
    catalogPrice: price4('catalog_price'),
    discount: money('discount').notNull().default('0'),
    lineTotal: money('line_total').notNull(),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('0'),
  },
  (t) => [index('sale_line_sale_idx').on(t.saleId), index('sale_line_product_idx').on(t.productId)],
);

export const salePayment = app.table(
  'sale_payment',
  {
    id: id(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sale.id, { onDelete: 'cascade' }),
    method: paymentMethod('method').notNull(),
    amount: money('amount').notNull(),
    tendered: money('tendered'),
    change: money('change'),
    /** R-CAG-05: change paid into the household's cagnotte instead of given back. */
    changeToWallet: boolean('change_to_wallet').notNull().default(false),
  },
  (t) => [index('sale_payment_sale_idx').on(t.saleId)],
);

/** §8.3 idempotency: one row per operation pushed by a device; replays return `result`. */
export const syncReceipt = app.table('sync_receipt', {
  clientId: uuid('client_id').primaryKey(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => posDevice.id),
  kind: text('kind').notNull(),
  receivedAt: tz('received_at').notNull().defaultNow(),
  result: jsonb('result').notNull(),
});

/** Gapless counters for readable numbers (tickets per year, §5.2 and §5.7). */
export const numberCounter = app.table('number_counter', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
});

/** R-CAG-03 balance per household; created by migration 0002. */
export const householdBalance = app
  .view('household_balance', {
    householdId: uuid('household_id').notNull(),
    balance: money('balance').notNull(),
    lastEntryAt: tz('last_entry_at'),
  })
  .existing();

/** R-ADH-04: one reminder per membership, so the daily job never sends it twice. */
export const membershipReminder = app.table('membership_reminder', {
  membershipId: uuid('membership_id')
    .primaryKey()
    .references(() => membership.id, { onDelete: 'cascade' }),
  sentAt: tz('sent_at').notNull().defaultNow(),
  to: text('to'),
});

// ===========================================================================
// Lot 2: supplies, receipts, invoices, inventory
// ===========================================================================

export const supplierPaymentMethod = app.enum('supplier_payment_method', [
  'CASH',
  'CHEQUE',
  'CARD',
  'TRANSFER',
  'DIRECT_DEBIT',
]);
export const purchaseOrderStatus = app.enum('purchase_order_status', [
  'DRAFT',
  'SENT',
  'PARTIAL',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
]);
export const supplierInvoiceStatus = app.enum('supplier_invoice_status', ['TO_PAY', 'PAID']);
export const inventoryStatus = app.enum('inventory_status', ['OPEN', 'VALIDATED', 'CANCELLED']);

/** R-CMD-*: supplier purchase order; totals are recomputed from the lines. */
export const purchaseOrder = app.table(
  'purchase_order',
  {
    id: id(),
    number: text('number').notNull().unique(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id),
    date: date('date').notNull(),
    status: purchaseOrderStatus('status').notNull().default('DRAFT'),
    comment: text('comment'),
    totalExcl: money('total_excl').notNull().default('0'),
    totalVat: money('total_vat').notNull().default('0'),
    totalIncl: money('total_incl').notNull().default('0'),
    sentAt: tz('sent_at'),
    sentTo: text('sent_to'),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacyFnrcomid: integer('legacy_fnrcomid').unique(),
  },
  (t) => [
    index('purchase_order_supplier_idx').on(t.supplierId, t.date),
    index('purchase_order_status_idx').on(t.status),
  ],
);

export const purchaseOrderLine = app.table(
  'purchase_order_line',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrder.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id),
    qtyOrdered: qty('qty_ordered').notNull(),
    unitPriceExcl: price4('unit_price_excl').notNull(),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull(),
    /** Sum of the received quantities (R-CMD-06). */
    qtyReceived: qty('qty_received').notNull().default('0'),
  },
  (t) => [
    index('purchase_order_line_order_idx').on(t.orderId),
    check('purchase_order_line_qty_positive', sql`${t.qtyOrdered} > 0`),
  ],
);

/** R-CMD-05: a receipt, with or without an order; its lines create PURCHASE_IN movements. */
export const goodsReceipt = app.table(
  'goods_receipt',
  {
    id: id(),
    number: text('number').notNull().unique(),
    orderId: uuid('order_id').references(() => purchaseOrder.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id),
    date: date('date').notNull(),
    receivedBy: uuid('received_by').references(() => member.id, { onDelete: 'set null' }),
    comment: text('comment'),
    createdAt: createdAt(),
    legacyFnrcomid: integer('legacy_fnrcomid').unique(),
  },
  (t) => [
    index('goods_receipt_supplier_idx').on(t.supplierId, t.date),
    index('goods_receipt_order_idx').on(t.orderId),
  ],
);

export const goodsReceiptLine = app.table(
  'goods_receipt_line',
  {
    id: id(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => goodsReceipt.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id),
    qty: qty('qty').notNull(),
    unitPriceExcl: price4('unit_price_excl').notNull(),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull(),
    orderLineId: uuid('order_line_id').references(() => purchaseOrderLine.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('goods_receipt_line_receipt_idx').on(t.receiptId),
    check('goods_receipt_line_qty_positive', sql`${t.qty} > 0`),
  ],
);

/** R-FAC-01: supplier invoice. The accounting entries (R-FAC-03/04) come with lot 3. */
export const supplierInvoice = app.table(
  'supplier_invoice',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id),
    pieceRef: text('piece_ref').notNull(),
    date: date('date').notNull(),
    dueDate: date('due_date').notNull(),
    totalExcl: money('total_excl').notNull(),
    totalVat: money('total_vat').notNull().default('0'),
    totalIncl: money('total_incl').notNull(),
    status: supplierInvoiceStatus('status').notNull().default('TO_PAY'),
    paymentMethod: supplierPaymentMethod('payment_method'),
    paidAt: date('paid_at'),
    documentMediaId: uuid('document_media_id').references(() => media.id, { onDelete: 'set null' }),
    /** R-FAC-05: the J−3 alert is sent once. */
    dueReminderSentAt: tz('due_reminder_sent_at'),
    /** R-FAC-03/04: the purchase entry and the payment entry. */
    entryId: uuid('entry_id').references((): AnyPgColumn => entry.id, { onDelete: 'set null' }),
    paymentEntryId: uuid('payment_entry_id').references((): AnyPgColumn => entry.id, {
      onDelete: 'set null',
    }),
    /** Overrides the default purchase account (R-FAC-03). */
    expenseAccountNumber: text('expense_account_number'),
    comment: text('comment'),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacyFactid: integer('legacy_factid').unique(),
  },
  (t) => [
    uniqueIndex('supplier_invoice_piece_uq').on(t.supplierId, t.pieceRef),
    index('supplier_invoice_due_idx').on(t.status, t.dueDate),
    check('supplier_invoice_due_after_date', sql`${t.dueDate} >= ${t.date}`),
    check('supplier_invoice_totals', sql`${t.totalIncl} = ${t.totalExcl} + ${t.totalVat}`),
  ],
);

/** R-FAC-02: an invoice covers one or several receipts. */
export const invoiceReceipt = app.table(
  'invoice_receipt',
  {
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => supplierInvoice.id, { onDelete: 'cascade' }),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => goodsReceipt.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.invoiceId, t.receiptId] })],
);

/** R-STK-04: inventory session, total or partial; the theoretical stock is frozen at opening. */
export const inventorySession = app.table('inventory_session', {
  id: id(),
  label: text('label').notNull(),
  /** { supplierId?, categoryId?, productIds? } — empty means the whole catalogue. */
  scope: jsonb('scope').notNull(),
  status: inventoryStatus('status').notNull().default('OPEN'),
  openedAt: tz('opened_at').notNull().defaultNow(),
  openedBy: uuid('opened_by').references(() => member.id, { onDelete: 'set null' }),
  validatedAt: tz('validated_at'),
  validatedBy: uuid('validated_by').references(() => member.id, { onDelete: 'set null' }),
  zeroUncounted: boolean('zero_uncounted').notNull().default(false),
  legacyDate: date('legacy_date').unique(),
});

export const inventoryLine = app.table(
  'inventory_line',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => inventorySession.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id),
    theoreticalQty: qty('theoretical_qty').notNull(),
    /** Null until counted; counts add up (R-STK-04 "saisie cumulative"). */
    countedQty: qty('counted_qty'),
    countedAt: tz('counted_at'),
    countedBy: uuid('counted_by').references(() => member.id, { onDelete: 'set null' }),
    unitCostExcl: price4('unit_cost_excl'),
    unitCostIncl: price4('unit_cost_incl'),
    /** Movement applied at validation (counted − theoretical, corrected by sales meanwhile). */
    adjustment: qty('adjustment'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.productId] })],
);

// ===========================================================================
// Lot 3: accounting
// ===========================================================================

export const fiscalYearStatus = app.enum('fiscal_year_status', ['OPEN', 'CLOSED']);
export const entryStatus = app.enum('entry_status', ['DRAFT', 'VALIDATED']);
export const normalSide = app.enum('normal_side', ['D', 'C', 'M']);
/** Payment mode of an entry (legacy MVTRGLT 0–5). */
export const entryMode = app.enum('entry_mode', [
  'CASH',
  'CHEQUE',
  'CARD',
  'TRANSFER',
  'DIRECT_DEBIT',
  'OTHER',
]);
export const bankRuleMatch = app.enum('bank_rule_match', ['CONTAINS', 'STARTS', 'REGEX']);
export const bankRuleDirection = app.enum('bank_rule_direction', ['IN', 'OUT', 'ANY']);
export const bankLineStatus = app.enum('bank_line_status', ['NEW', 'MATCHED']);
export const statementStatus = app.enum('statement_status', ['OPEN', 'CLOSED']);
export const depositKind = app.enum('deposit_kind', ['CASH', 'CHEQUES']);

/** R-CPT-03: fiscal years are objects; overlapping dates are refused by an exclusion constraint. */
export const fiscalYear = app.table(
  'fiscal_year',
  {
    id: id(),
    label: text('label').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: fiscalYearStatus('status').notNull().default('OPEN'),
    closedAt: tz('closed_at'),
    closedBy: uuid('closed_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [check('fiscal_year_dates', sql`${t.endDate} >= ${t.startDate}`)],
);

export const account = app.table(
  'account',
  {
    id: id(),
    number: text('number').notNull().unique(),
    label: text('label').notNull(),
    normalSide: normalSide('normal_side').notNull().default('D'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('account_number_six_digits', sql`${t.number} ~ '^[0-9]{6}$'`)],
);

export const journal = app.table('journal', {
  id: id(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

/** R-CPT-04/05: an entry is a draft until validated; the number is given at validation. */
export const entry = app.table(
  'entry',
  {
    id: id(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journal.id),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYear.id),
    /** Per journal and fiscal year; null while a draft. */
    number: integer('number'),
    date: date('date').notNull(),
    pieceRef: text('piece_ref'),
    label: text('label').notNull(),
    mode: entryMode('mode'),
    status: entryStatus('status').notNull().default('DRAFT'),
    /** Origin of an automatic entry (session, invoice, invoice_payment, bank_line, deposit, closing_*). */
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    reversesEntryId: uuid('reverses_entry_id').references((): AnyPgColumn => entry.id),
    validatedAt: tz('validated_at'),
    validatedBy: uuid('validated_by').references(() => member.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    legacyMvtnum: integer('legacy_mvtnum').unique(),
  },
  (t) => [
    uniqueIndex('entry_number_uq')
      .on(t.journalId, t.fiscalYearId, t.number)
      .where(sql`${t.number} is not null`),
    uniqueIndex('entry_source_uq')
      .on(t.sourceType, t.sourceId)
      .where(sql`${t.sourceType} is not null and ${t.sourceId} is not null`),
    index('entry_date_idx').on(t.date),
    index('entry_year_journal_idx').on(t.fiscalYearId, t.journalId),
    check('entry_validated_has_number', sql`${t.status} = 'DRAFT' or ${t.number} is not null`),
  ],
);

/** R-CPT-14: one record per bank statement being reconciled (or per legacy month). */
export const reconciliation = app.table('reconciliation', {
  id: id(),
  /** Set after the statement table below; null for the migrated monthly "pointage". */
  statementId: uuid('statement_id'),
  label: text('label').notNull(),
  doneAt: tz('done_at').notNull().defaultNow(),
  doneBy: uuid('done_by').references(() => member.id, { onDelete: 'set null' }),
});

export const entryLine = app.table(
  'entry_line',
  {
    id: id(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entry.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    label: text('label').notNull(),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
    reconciliationId: uuid('reconciliation_id').references(() => reconciliation.id, {
      onDelete: 'set null',
    }),
    /** R-FAC-04: links an invoice line and its payment line. */
    letteringCode: text('lettering_code'),
    letteredOn: date('lettered_on'),
  },
  (t) => [
    index('entry_line_entry_idx').on(t.entryId),
    index('entry_line_account_idx').on(t.accountId),
    index('entry_line_lettering_idx').on(t.letteringCode),
    check(
      'entry_line_amounts',
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} = 0 or ${t.credit} = 0)`,
    ),
  ],
);

// --- Templates ("guides", R-CPT-06) ---------------------------------------------------

export const entryTemplateCategory = app.table('entry_template_category', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  sort: integer('sort').notNull().default(0),
});

export const entryTemplate = app.table('entry_template', {
  id: id(),
  categoryCode: text('category_code').references(() => entryTemplateCategory.code),
  journalId: uuid('journal_id')
    .notNull()
    .references(() => journal.id),
  label: text('label').notNull(),
  mode: entryMode('mode'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  legacyGuinum: integer('legacy_guinum').unique(),
});

export const entryTemplateLine = app.table(
  'entry_template_line',
  {
    id: id(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => entryTemplate.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    label: text('label').notNull(),
    /** Fixed amounts; both null means "to enter". */
    debit: money('debit'),
    credit: money('credit'),
  },
  (t) => [index('entry_template_line_idx').on(t.templateId)],
);

// --- Bank (R-CPT-12..15) -------------------------------------------------------------------

export const bankAccount = app.table('bank_account', {
  id: id(),
  label: text('label').notNull(),
  iban: text('iban'),
  /** The 512… account of the books. */
  accountId: uuid('account_id')
    .notNull()
    .references(() => account.id),
  active: boolean('active').notNull().default(true),
});

export const bankStatement = app.table(
  'bank_statement',
  {
    id: id(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccount.id),
    fileName: text('file_name').notNull(),
    fileHash: text('file_hash').notNull(),
    format: text('format').notNull(),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    openingBalance: money('opening_balance').notNull(),
    closingBalance: money('closing_balance').notNull(),
    importedAt: tz('imported_at').notNull().defaultNow(),
    importedBy: uuid('imported_by').references(() => member.id, { onDelete: 'set null' }),
    status: statementStatus('status').notNull().default('OPEN'),
    closedAt: tz('closed_at'),
    closedBy: uuid('closed_by').references(() => member.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('bank_statement_file_uq').on(t.bankAccountId, t.fileHash)],
);

export const bankRule = app.table(
  'bank_rule',
  {
    id: id(),
    priority: integer('priority').notNull().default(100),
    label: text('label').notNull(),
    pattern: text('pattern').notNull(),
    matchType: bankRuleMatch('match_type').notNull().default('CONTAINS'),
    direction: bankRuleDirection('direction').notNull().default('ANY'),
    minAmount: money('min_amount'),
    maxAmount: money('max_amount'),
    counterAccountId: uuid('counter_account_id').references(() => account.id),
    journalId: uuid('journal_id').references(() => journal.id),
    mode: entryMode('mode'),
    labelTemplate: text('label_template'),
    /** R-CPT-09: money in from a household transfer: top-up of the cagnotte. */
    householdMatch: boolean('household_match').notNull().default(false),
    supplierId: uuid('supplier_id').references(() => supplier.id, { onDelete: 'set null' }),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('bank_rule_priority_idx').on(t.priority)],
);

export const bankLine = app.table(
  'bank_line',
  {
    id: id(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatement.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccount.id),
    fitid: text('fitid'),
    fingerprint: text('fingerprint').notNull(),
    date: date('date').notNull(),
    /** Signed: positive is money in. */
    amount: money('amount').notNull(),
    label: text('label').notNull(),
    memo: text('memo'),
    status: bankLineStatus('status').notNull().default('NEW'),
    /** The 512 entry line this bank line is reconciled with. */
    entryLineId: uuid('entry_line_id').references(() => entryLine.id, { onDelete: 'set null' }),
    ruleId: uuid('rule_id').references(() => bankRule.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('bank_line_fitid_uq')
      .on(t.bankAccountId, t.fitid)
      .where(sql`${t.fitid} is not null`),
    uniqueIndex('bank_line_fingerprint_uq').on(t.bankAccountId, t.fingerprint),
    index('bank_line_statement_idx').on(t.statementId),
  ],
);

/** R-SES-04: deposits at the bank (cash or cheques), replacing `remcheques`. */
export const cashDeposit = app.table('cash_deposit', {
  id: id(),
  date: date('date').notNull(),
  kind: depositKind('kind').notNull(),
  amount: money('amount').notNull(),
  bankAccountId: uuid('bank_account_id')
    .notNull()
    .references(() => bankAccount.id),
  /** Cheques of the slip: [{ drawer, bank, amount }]. */
  chequeList: jsonb('cheque_list'),
  comment: text('comment'),
  entryId: uuid('entry_id').references(() => entry.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  legacyRef: text('legacy_ref').unique(),
});

// --- Pre-orders (R-PRE-01..03) -------------------------------------------------------------

export const preorderStatus = app.enum('preorder_status', PREORDER_STATUSES);

/** A customer's order, placed from the online cart and collected (and paid) at the till. */
export const preorder = app.table(
  'preorder',
  {
    id: id(),
    number: text('number').notNull().unique(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id),
    householdId: uuid('household_id').references(() => household.id),
    status: preorderStatus('status').notNull().default('SUBMITTED'),
    /** Desired pick-up date (R-PRE-01). */
    pickupDate: date('pickup_date').notNull(),
    comment: text('comment'),
    /** Set when the order is turned into a till ticket (R-PRE-03). */
    saleId: uuid('sale_id').references(() => sale.id, { onDelete: 'set null' }),
    /** The member, or the volunteer who keyed it in for them. */
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('preorder_member_idx').on(t.memberId, t.createdAt),
    index('preorder_status_idx').on(t.status, t.pickupDate),
  ],
);

export const preorderLine = app.table(
  'preorder_line',
  {
    id: id(),
    preorderId: uuid('preorder_id')
      .notNull()
      .references(() => preorder.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id),
    label: text('label').notNull(),
    qty: qty('qty').notNull(),
    /** Catalogue price when ordered, for information: the till charges the price of the day. */
    unitPrice: money('unit_price').notNull(),
  },
  (t) => [
    index('preorder_line_order_idx').on(t.preorderId),
    index('preorder_line_product_idx').on(t.productId),
    check('preorder_line_qty_positive', sql`${t.qty} > 0`),
  ],
);

// --- Saved reports and imports (R-STA-05, R-IMP-01..04) ------------------------------------

/** A named, read-only report: a kind of the fixed library plus its filters. Never free SQL. */
export const savedReport = app.table(
  'saved_report',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    params: jsonb('params').notNull().default({}),
    /** Visible to every STATS user; otherwise only to its author. */
    shared: boolean('shared').notNull().default(false),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('saved_report_author_idx').on(t.createdBy)],
);

/** R-IMP-04: who imported which file, when, with what outcome. */
export const importLog = app.table(
  'import_log',
  {
    id: id(),
    kind: text('kind').notNull(),
    fileName: text('file_name').notNull(),
    fileHash: text('file_hash').notNull(),
    summary: jsonb('summary').notNull().default({}),
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('import_log_kind_idx').on(t.kind, t.createdAt)],
);

/** Remembered matches between a file and the app: supplier names, column headers. */
export const importMapping = app.table(
  'import_mapping',
  {
    id: id(),
    kind: text('kind').notNull(),
    sourceKey: text('source_key').notNull(),
    target: text('target').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('import_mapping_uq').on(t.kind, t.sourceKey)],
);

// --- Customer reviews (shop) -----------------------------------------------------------------

/** A member's rating and comment on a product; shown once a PRODUITS user approves it. */
export const productReview = app.table(
  'product_review',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    comment: text('comment'),
    status: text('status').notNull().default('PENDING'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('product_review_uq').on(t.productId, t.memberId),
    index('product_review_status_idx').on(t.status, t.createdAt),
    check('product_review_rating', sql`${t.rating} between 1 and 5`),
  ],
);
