import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { MEMBER_STATUSES } from '@episoft/shared';

// Target data model, spec §6. Lot 0 tables only; later lots add theirs here.

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
