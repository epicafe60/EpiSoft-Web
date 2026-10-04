import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, ilike, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  commune,
  household,
  householdBalance,
  loginLog,
  member,
  memberPayment,
  membership,
  membershipType,
  product,
  sale,
  productReview,
  pushSubscription,
  session,
  userRole,
  walletEntry,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  decimalToCents,
  householdPatchSchema,
  MEMBER_STATUSES,
  memberCreateSchema,
  membershipCreateSchema,
  membershipPeriod,
  membershipTypePatchSchema,
  memberPatchSchema,
  normalizeSearch,
  sha256Hex,
  walletCorrectionSchema,
  walletTopupSchema,
  type PaymentMethod,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { toParisDate } from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { currentMembershipEnd, lockedBalanceCents } from '../pos/wallet';
import { sendTopupReceipt } from '../pos/sync-service';

/** R-MBR-05: random badge token of 20 characters (≥ 15). Only its hash is stored. */
function newQrToken(): string {
  return randomBytes(15).toString('base64url');
}

const idParams = { params: z.object({ id: z.string().uuid() }) };

/** Accent-insensitive comparison without the unaccent extension (ADR 0001 §6). */
export const fold = (col: SQL | AnyColumn) =>
  sql`translate(lower(${col}), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœ', 'aaaaaaceeeeiiiinooooouuuuyyo')`;

function assertFresh(current: Date, expected: string) {
  // §8.1 optimistic concurrency: the client sends the updatedAt it loaded.
  if (current.toISOString() !== new Date(expected).toISOString()) {
    throw conflict('La fiche a été modifiée entre-temps. Rechargez-la avant d’enregistrer.');
  }
}

export const memberRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const adherents = { preHandler: app.requireRoles('ADHERENTS') };

  // --- Reference lists ---------------------------------------------------------------

  app.get('/communes', async () =>
    db
      .select({ id: commune.id, postcode: commune.postcode, name: commune.name })
      .from(commune)
      .orderBy(commune.name),
  );

  app.get('/membership-types', async () =>
    db.select().from(membershipType).orderBy(membershipType.sort),
  );

  app.put(
    '/membership-types/:id',
    {
      preHandler: app.requireRoles('ADMIN'),
      schema: { ...idParams, body: membershipTypePatchSchema },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(membershipType)
          .where(eq(membershipType.id, req.params.id));
        if (!before) throw notFound('Type d’adhésion inconnu.');
        const [after] = await tx
          .update(membershipType)
          .set(req.body)
          .where(eq(membershipType.id, req.params.id))
          .returning();
        // The till sells the membership through its service product: same price (R-ADH-05).
        if (after!.productId) {
          await tx
            .update(product)
            .set({ salePrice: after!.price, name: `Adhésion ${after!.label.toLowerCase()}` })
            .where(eq(product.id, after!.productId));
        }
        await audit(tx, req, {
          action: 'membership_type.update',
          entity: 'membership_type',
          entityId: before.id,
          before,
          after,
        });
        return after;
      }),
  );

  // --- Members (R-MBR-01, R-MBR-06) ---------------------------------------------------

  app.get(
    '/members',
    {
      preHandler: app.requireRoles('ADHERENTS', 'CAISSE'),
      schema: {
        querystring: z.object({
          q: z.string().max(100).optional(),
          status: z.enum(MEMBER_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req) => {
      const f: SQL[] = [];
      const q = req.query.q ? normalizeSearch(req.query.q) : '';
      if (q) {
        const like = `%${q}%`;
        f.push(
          or(
            sql`${fold(member.lastName)} like ${like}`,
            sql`${fold(member.firstName)} like ${like}`,
            sql`${fold(sql`${member.firstName} || ' ' || ${member.lastName}`)} like ${like}`,
            sql`${fold(sql`${member.lastName} || ' ' || ${member.firstName}`)} like ${like}`,
            ilike(member.email, like),
            sql`regexp_replace(coalesce(${member.phone}, ''), '\\D', '', 'g') like ${'%' + q.replace(/\D/g, '') + '%'} and ${q.replace(/\D/g, '').length >= 4}`,
            /^\d+$/.test(q) ? eq(member.number, Number(q)) : undefined,
            // A scanned badge (R-MBR-06: search by QR).
            q.length >= 10
              ? eq(member.qrTokenHash, await sha256Hex(req.query.q!.trim()))
              : undefined,
          )!,
        );
      }
      f.push(
        req.query.status ? eq(member.status, req.query.status) : ne(member.status, 'ARCHIVED'),
      );
      const rows = await db
        .select({
          id: member.id,
          number: member.number,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          phone: member.phone,
          status: member.status,
          householdId: member.householdId,
          householdNumber: household.number,
          isReferent: sql<boolean>`${household.referentMemberId} = ${member.id}`,
          balance: householdBalance.balance,
          membershipEnd: sql<
            string | null
          >`(select max(end_date) from app.membership x where x.household_id = ${member.householdId} and x.cancelled_at is null)`,
        })
        .from(member)
        .leftJoin(household, eq(household.id, member.householdId))
        .leftJoin(householdBalance, eq(householdBalance.householdId, member.householdId))
        .where(and(...f))
        .orderBy(asc(member.lastName), asc(member.firstName))
        .limit(req.query.limit);
      return rows;
    },
  );

  app.get('/members/:id', { ...adherents, schema: idParams }, async (req) => {
    const m = await db.query.member.findFirst({ where: eq(member.id, req.params.id) });
    if (!m) throw notFound('Membre introuvable.');
    const roles = await db
      .select({ code: userRole.roleCode })
      .from(userRole)
      .where(eq(userRole.memberId, m.id));
    const { passwordHash, qrTokenHash, ...rest } = m;
    return {
      ...rest,
      newsletter: m.newsletterOptInAt !== null,
      hasPassword: passwordHash !== null,
      hasQr: qrTokenHash !== null,
      roles: roles.map((r) => r.code),
      newsletterOptInAt: m.newsletterOptInAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    };
  });

  app.post('/members', { ...adherents, schema: { body: memberCreateSchema } }, async (req) => {
    const { householdId, newsletter, ...fields } = req.body;
    const token = newQrToken();
    const created = await db.transaction(async (tx) => {
      await assertUniqueContacts(tx, fields.username, fields.email, null);
      let hid = householdId;
      if (hid) {
        if (!(await tx.query.household.findFirst({ where: eq(household.id, hid) })))
          throw badRequest('Foyer inconnu.');
      } else {
        const [h] = await tx.insert(household).values({}).returning({ id: household.id });
        hid = h!.id;
      }
      const [m] = await tx
        .insert(member)
        .values({
          ...fields,
          householdId: hid,
          newsletterOptInAt: newsletter ? new Date() : null,
          qrTokenHash: await sha256Hex(token),
        })
        .returning();
      if (!householdId)
        await tx.update(household).set({ referentMemberId: m!.id }).where(eq(household.id, hid));
      await audit(tx, req, {
        action: 'member.create',
        entity: 'member',
        entityId: m!.id,
        after: { ...fields, householdId: hid },
      });
      return m!;
    });
    // The badge token is shown once, to print the badge (R-MBR-05).
    return {
      id: created.id,
      number: created.number,
      householdId: created.householdId,
      qrToken: token,
    };
  });

  app.patch(
    '/members/:id',
    { ...adherents, schema: { ...idParams, body: memberPatchSchema } },
    async (req) => {
      const { updatedAt, newsletter, ...fields } = req.body;
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(member)
          .where(eq(member.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Membre introuvable.');
        assertFresh(before.updatedAt, updatedAt);
        await assertUniqueContacts(tx, fields.username, fields.email, before.id);
        const set: Partial<typeof member.$inferInsert> = { ...fields };
        // R-MBR-08: consent is dated when given, cleared when withdrawn.
        if (newsletter !== undefined && newsletter !== (before.newsletterOptInAt !== null)) {
          set.newsletterOptInAt = newsletter ? new Date() : null;
        }
        if (fields.householdId && fields.householdId !== before.householdId) {
          if (
            !(await tx.query.household.findFirst({ where: eq(household.id, fields.householdId) }))
          )
            throw badRequest('Foyer inconnu.');
          if (before.householdId) await handOverReferent(tx, before.householdId, before.id);
        }
        if (fields.status === 'INACTIVE' || fields.status === 'ARCHIVED') {
          // Deactivation closes the member's sessions at once.
          await tx.delete(session).where(eq(session.memberId, before.id));
        }
        const [after] = await tx
          .update(member)
          .set(set)
          .where(eq(member.id, before.id))
          .returning();
        const changed = Object.keys(set) as (keyof typeof before)[];
        await audit(tx, req, {
          action: 'member.update',
          entity: 'member',
          entityId: before.id,
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after![k]])),
        });
        return { id: after!.id, updatedAt: after!.updatedAt.toISOString() };
      });
    },
  );

  app.post('/members/:id/qr', { ...adherents, schema: idParams }, async (req) => {
    const token = newQrToken();
    await db.transaction(async (tx) => {
      const [m] = await tx
        .update(member)
        .set({ qrTokenHash: await sha256Hex(token) })
        .where(eq(member.id, req.params.id))
        .returning({ id: member.id });
      if (!m) throw notFound('Membre introuvable.');
      await audit(tx, req, { action: 'member.qr_regenerate', entity: 'member', entityId: m.id });
    });
    return { qrToken: token };
  });

  /** R-MBR-08: everything held about a member, as JSON. */
  app.get('/members/:id/export', { ...adherents, schema: idParams }, async (req, reply) => {
    const m = await db.query.member.findFirst({ where: eq(member.id, req.params.id) });
    if (!m) throw notFound('Membre introuvable.');
    const { passwordHash: _p, qrTokenHash: _q, ...data } = m;
    const roles = await db
      .select({ code: userRole.roleCode })
      .from(userRole)
      .where(eq(userRole.memberId, m.id));
    const sales = await db
      .select({ number: sale.number, soldAt: sale.soldAt, total: sale.total })
      .from(sale)
      .where(eq(sale.memberId, m.id))
      .orderBy(desc(sale.soldAt));
    const logins = await db
      .select({ at: loginLog.at, success: loginLog.success, ip: loginLog.ip })
      .from(loginLog)
      .where(eq(loginLog.memberId, m.id))
      .orderBy(desc(loginLog.at));
    const hh = m.householdId ? await householdDetail(db, m.householdId) : null;
    await audit(db, req, { action: 'member.export', entity: 'member', entityId: m.id });
    void reply.header('content-disposition', `attachment; filename="membre-${m.number}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      member: data,
      roles: roles.map((r) => r.code),
      household: hh,
      sales,
      logins,
    };
  });

  /** R-MBR-08: anonymisation at archiving; amounts are kept for the accounts. */
  app.post(
    '/members/:id/anonymize',
    { preHandler: app.requireRoles('ADMIN'), schema: idParams },
    async (req) => {
      await db.transaction(async (tx) => {
        const [m] = await tx
          .select()
          .from(member)
          .where(eq(member.id, req.params.id))
          .for('update');
        if (!m) throw notFound('Membre introuvable.');
        await tx.delete(userRole).where(eq(userRole.memberId, m.id));
        await tx.delete(session).where(eq(session.memberId, m.id));
        // Free-text reviews and devices are personal data too.
        await tx.delete(productReview).where(eq(productReview.memberId, m.id));
        await tx.delete(pushSubscription).where(eq(pushSubscription.memberId, m.id));
        await tx
          .update(member)
          .set({
            lastName: `Membre #${m.number}`,
            firstName: '-',
            street: null,
            postcode: null,
            communeId: null,
            phone: null,
            email: null,
            username: null,
            passwordHash: null,
            qrTokenHash: null,
            newsletterOptInAt: null,
            publicVisible: false,
            status: 'ARCHIVED',
          })
          .where(eq(member.id, m.id));
        await audit(tx, req, { action: 'member.anonymize', entity: 'member', entityId: m.id });
      });
      return { ok: true };
    },
  );

  // --- Households (R-MBR-02, R-MBR-07) -------------------------------------------------

  app.get('/households/:id', { ...adherents, schema: idParams }, async (req) => {
    const d = await householdDetail(db, req.params.id);
    if (!d) throw notFound('Foyer introuvable.');
    return d;
  });

  app.patch(
    '/households/:id',
    { ...adherents, schema: { ...idParams, body: householdPatchSchema } },
    async (req) => {
      const { updatedAt, ...fields } = req.body;
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(household)
          .where(eq(household.id, req.params.id))
          .for('update');
        if (!before) throw notFound('Foyer introuvable.');
        assertFresh(before.updatedAt, updatedAt);
        if (fields.referentMemberId) {
          const m = await tx.query.member.findFirst({
            where: and(eq(member.id, fields.referentMemberId), eq(member.householdId, before.id)),
          });
          if (!m) throw badRequest('Le référent doit être un membre du foyer.');
        }
        if (fields.transferReference) {
          const dup = await tx.query.household.findFirst({
            where: and(
              eq(household.transferReference, fields.transferReference),
              ne(household.id, before.id),
            ),
          });
          if (dup)
            throw conflict(
              `Cette référence de virement est déjà utilisée par le foyer n° ${dup.number}.`,
            );
        }
        const [after] = await tx
          .update(household)
          .set(fields)
          .where(eq(household.id, before.id))
          .returning();
        await audit(tx, req, {
          action: 'household.update',
          entity: 'household',
          entityId: before.id,
          before,
          after,
        });
        return { id: after!.id, updatedAt: after!.updatedAt.toISOString() };
      });
    },
  );

  /** Back-office top-up (R-CAG-01, R-CAG-06). Not tied to a till session. */
  app.post(
    '/households/:id/wallet/topup',
    { ...adherents, schema: { ...idParams, body: walletTopupSchema } },
    async (req) => {
      const b = req.body;
      return db.transaction(async (tx) => {
        const h = await tx.query.household.findFirst({ where: eq(household.id, req.params.id) });
        if (!h) throw notFound('Foyer introuvable.');
        const before = await lockedBalanceCents(tx, h.id);
        const at = new Date();
        const [pay] = await tx
          .insert(memberPayment)
          .values({
            householdId: h.id,
            date: b.date ?? toParisDate(at),
            amount: b.amount,
            purpose: 'TOPUP',
            method: b.method,
            comment: b.comment ?? null,
            createdBy: req.user!.id,
          })
          .returning();
        const [entry] = await tx
          .insert(walletEntry)
          .values({
            householdId: h.id,
            at,
            amount: b.amount,
            kind: 'TOPUP',
            paymentMethod: b.method,
            paymentId: pay!.id,
            comment: b.comment ?? null,
            createdBy: req.user!.id,
          })
          .returning();
        await audit(tx, req, {
          action: 'wallet.topup',
          entity: 'household',
          entityId: h.id,
          after: { amount: b.amount, method: b.method },
        });
        if (b.emailReceipt)
          await sendTopupReceipt(tx, h.id, h.referentMemberId, {
            at,
            amountCents: decimalToCents(b.amount),
            beforeCents: before,
            method: b.method as PaymentMethod,
          });
        return { id: entry!.id };
      });
    },
  );

  app.post(
    '/households/:id/wallet/correction',
    { ...adherents, schema: { ...idParams, body: walletCorrectionSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const h = await tx.query.household.findFirst({ where: eq(household.id, req.params.id) });
        if (!h) throw notFound('Foyer introuvable.');
        const before = await lockedBalanceCents(tx, h.id);
        const [entry] = await tx
          .insert(walletEntry)
          .values({
            householdId: h.id,
            amount: req.body.amount,
            kind: 'CORRECTION',
            comment: req.body.comment,
            createdBy: req.user!.id,
          })
          .returning();
        await audit(tx, req, {
          action: 'wallet.correction',
          entity: 'household',
          entityId: h.id,
          before: { balanceCents: before },
          after: { amount: req.body.amount, comment: req.body.comment },
        });
        return { id: entry!.id };
      }),
  );

  /** Membership paid at the back office (R-ADH-02). */
  app.post(
    '/households/:id/memberships',
    { ...adherents, schema: { ...idParams, body: membershipCreateSchema } },
    async (req) => {
      const b = req.body;
      return db.transaction(async (tx) => {
        const h = await tx.query.household.findFirst({ where: eq(household.id, req.params.id) });
        if (!h) throw notFound('Foyer introuvable.');
        const type = await tx.query.membershipType.findFirst({
          where: eq(membershipType.id, b.typeId),
        });
        if (!type) throw badRequest('Type d’adhésion inconnu.');
        const date = b.date ?? toParisDate(new Date());
        const amount = b.amount ?? type.price;
        const [pay] = await tx
          .insert(memberPayment)
          .values({
            householdId: h.id,
            date,
            amount,
            purpose: 'MEMBERSHIP',
            method: b.method,
            createdBy: req.user!.id,
          })
          .returning();
        const period = membershipPeriod(
          date,
          type.durationMonths,
          await currentMembershipEnd(tx, h.id),
        );
        const [ms] = await tx
          .insert(membership)
          .values({
            householdId: h.id,
            typeId: type.id,
            startDate: period.start,
            endDate: period.end,
            amount,
            paymentId: pay!.id,
            createdBy: req.user!.id,
          })
          .returning();
        await audit(tx, req, {
          action: 'membership.create',
          entity: 'household',
          entityId: h.id,
          after: ms,
        });
        return ms;
      });
    },
  );
};

async function assertUniqueContacts(
  tx: Tx,
  username: string | null | undefined,
  email: string | null | undefined,
  selfId: string | null,
) {
  const clash = async (col: typeof member.username | typeof member.email, value: string) =>
    tx.query.member.findFirst({
      where: and(sql`lower(${col}) = lower(${value})`, selfId ? ne(member.id, selfId) : undefined),
    });
  if (username && (await clash(member.username, username)))
    throw conflict('Cet identifiant est déjà utilisé.');
  if (email && (await clash(member.email, email)))
    throw conflict('Ce courriel est déjà utilisé par un autre membre.');
}

/** A member leaving a household: the referent role passes to another member, if any. */
async function handOverReferent(tx: Tx, householdId: string, leavingId: string) {
  const h = await tx.query.household.findFirst({ where: eq(household.id, householdId) });
  if (h?.referentMemberId !== leavingId) return;
  const other = await tx.query.member.findFirst({
    where: and(eq(member.householdId, householdId), ne(member.id, leavingId)),
  });
  await tx
    .update(household)
    .set({ referentMemberId: other?.id ?? null })
    .where(eq(household.id, householdId));
}

/** R-MBR-07: the "360°" view of a household. */
export async function householdDetail(db: Db | Tx, id: string) {
  const h = await db.query.household.findFirst({ where: eq(household.id, id) });
  if (!h) return null;
  const members = await db
    .select({
      id: member.id,
      number: member.number,
      firstName: member.firstName,
      lastName: member.lastName,
      status: member.status,
      email: member.email,
      phone: member.phone,
    })
    .from(member)
    .where(eq(member.householdId, id))
    .orderBy(member.number);
  const [bal] = await db
    .select()
    .from(householdBalance)
    .where(eq(householdBalance.householdId, id));
  const memberships = await db
    .select({
      id: membership.id,
      type: membershipType.label,
      startDate: membership.startDate,
      endDate: membership.endDate,
      amount: membership.amount,
      saleId: membership.saleId,
      cancelledAt: membership.cancelledAt,
    })
    .from(membership)
    .innerJoin(membershipType, eq(membershipType.id, membership.typeId))
    .where(eq(membership.householdId, id))
    .orderBy(desc(membership.endDate));
  const wallet = await db
    .select({
      id: walletEntry.id,
      at: walletEntry.at,
      amount: walletEntry.amount,
      kind: walletEntry.kind,
      paymentMethod: walletEntry.paymentMethod,
      saleId: walletEntry.saleId,
      saleNumber: sale.number,
      comment: walletEntry.comment,
      forced: sql<boolean>`${walletEntry.forcedBy} is not null`,
      // R-CAG-08: back-office top-up of today, not from the till.
      cancellable: sql<boolean>`${walletEntry.kind} = 'TOPUP' and ${walletEntry.saleId} is null and ${walletEntry.paymentId} is not null
        and (${walletEntry.createdAt} at time zone 'Europe/Paris')::date = (now() at time zone 'Europe/Paris')::date
        and not exists (select 1 from app.member_payment p where p.id = ${walletEntry.paymentId} and p.cash_session_id is not null)`,
      byName: sql<
        string | null
      >`(select first_name || ' ' || last_name from app.member x where x.id = ${walletEntry.createdBy})`,
    })
    .from(walletEntry)
    .leftJoin(sale, eq(sale.id, walletEntry.saleId))
    .where(eq(walletEntry.householdId, id))
    .orderBy(desc(walletEntry.at), desc(walletEntry.id))
    .limit(500);
  const payments = await db
    .select()
    .from(memberPayment)
    .where(eq(memberPayment.householdId, id))
    .orderBy(desc(memberPayment.date))
    .limit(200);
  return {
    id: h.id,
    number: h.number,
    referentMemberId: h.referentMemberId,
    transferReference: h.transferReference,
    notes: h.notes,
    updatedAt: h.updatedAt.toISOString(),
    balance: bal?.balance ?? '0.00',
    members,
    memberships: memberships.map((m) => ({
      ...m,
      cancelledAt: m.cancelledAt?.toISOString() ?? null,
    })),
    wallet: wallet.map((w) => ({ ...w, at: w.at.toISOString() })),
    payments: payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
  };
}
