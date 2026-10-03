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
  PRODUCT_KINDS,
  PRODUCT_STATUSES,
  SALE_CONDITIONS,
  SALE_MODES,
  STOCK_MOVEMENT_KINDS,
  UNITS,
  WALLET_ENTRY_KINDS,
} from '@episoft/shared';

// Target data model, spec §6. Tables of lots 0 and 1; later lots add theirs here.

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
