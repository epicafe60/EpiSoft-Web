import { and, desc, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { consent, member, pushSubscription, type Db, type DbOrTx } from '@episoft/db';
import {
  CONSENT_PURPOSES,
  CONSENTS,
  consentChangeSchema,
  currentConsents,
  type ConsentChannel,
  type ConsentPurpose,
  type ConsentRecord,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/problem';

/**
 * What counts as the state of a purpose that was never answered. The ticket e-mails follow the
 * service (a member who has an e-mail address receives them until they say no, R-EVO-40); every
 * other purpose needs a yes.
 */
const BASELINE: Record<ConsentPurpose, boolean> = {
  EMAIL_RECEIPTS: true,
  NOTIFICATIONS: false,
  NEWSLETTER: false,
  IMAGE_RIGHTS: false,
  DATA_PROCESSING: false,
};

const toRecord = (r: typeof consent.$inferSelect): ConsentRecord => ({
  id: r.id,
  purpose: r.purpose,
  granted: r.granted,
  textVersion: r.textVersion,
  channel: r.channel,
  at: r.at.toISOString(),
  recordedBy: r.recordedBy,
});

export async function consentHistory(db: DbOrTx, memberId: string): Promise<ConsentRecord[]> {
  const rows = await db
    .select()
    .from(consent)
    .where(eq(consent.memberId, memberId))
    .orderBy(desc(consent.at), desc(consent.id));
  return rows.map(toRecord);
}

/** The current choice of a member for a purpose (the baseline when never recorded). */
export async function consentState(
  db: DbOrTx,
  memberId: string,
  purpose: ConsentPurpose,
): Promise<boolean> {
  const [last] = await db
    .select({ granted: consent.granted })
    .from(consent)
    .where(and(eq(consent.memberId, memberId), eq(consent.purpose, purpose)))
    .orderBy(desc(consent.at), desc(consent.id))
    .limit(1);
  return last ? last.granted : BASELINE[purpose];
}

/**
 * Records a choice, with the version of the text shown and the way it was collected, in the same
 * transaction as the change it goes with. A choice that does not change anything is not recorded
 * again. Returns whether a row was added.
 */
export async function recordConsent(
  tx: DbOrTx,
  req: FastifyRequest,
  input: { memberId: string; purpose: ConsentPurpose; granted: boolean; channel: ConsentChannel },
): Promise<boolean> {
  if ((await consentState(tx, input.memberId, input.purpose)) === input.granted) return false;
  const def = CONSENTS[input.purpose];
  await tx.insert(consent).values({
    memberId: input.memberId,
    purpose: input.purpose,
    granted: input.granted,
    textVersion: def.version,
    channel: input.channel,
    recordedBy: req.user?.id ?? null,
  });
  await audit(tx, req, {
    action: 'consent.record',
    entity: 'member',
    entityId: input.memberId,
    after: {
      purpose: input.purpose,
      label: def.label,
      granted: input.granted,
      channel: input.channel,
      textVersion: def.version,
    },
  });
  return true;
}

/** A member's choices as shown on the sheet and in their area. */
export async function consentSummary(db: DbOrTx, memberId: string) {
  const history = await consentHistory(db, memberId);
  const current = currentConsents(history);
  return {
    items: CONSENT_PURPOSES.map((purpose) => {
      const last = current.get(purpose);
      const def = CONSENTS[purpose];
      return {
        purpose,
        label: def.label,
        text: def.text,
        version: def.version,
        basis: def.basis,
        withdrawable: def.withdrawable,
        granted: last ? last.granted : BASELINE[purpose],
        /** False: nothing was ever recorded for it (the value is the default of the service). */
        recorded: !!last,
        since: last?.at ?? null,
        channel: last?.channel ?? null,
        textVersion: last?.textVersion ?? null,
      };
    }),
    history,
  };
}

const idParams = { params: z.object({ id: z.string().uuid() }) };

export const consentRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  /** The consent history of a member, for the volunteers who manage the sheets. */
  app.get(
    '/members/:id/consents',
    { preHandler: app.requireRoles('ADHERENTS'), schema: idParams },
    async (req) => {
      const [m] = await db
        .select({ id: member.id })
        .from(member)
        .where(eq(member.id, req.params.id));
      if (!m) throw notFound('Membre introuvable.');
      return consentSummary(db, m.id);
    },
  );

  /** The member's own choices. */
  app.get('/me/consents', async (req) => consentSummary(db, req.user!.id));

  /**
   * The member changes a choice themselves, and withdraws it as easily as it was given (art. 7.3
   * RGPD). The sheet keeps the matching flag in step; the choice is recorded with its history.
   */
  app.put('/me/consents', { schema: { body: consentChangeSchema } }, async (req) => {
    const { purpose, granted } = req.body;
    const def = CONSENTS[purpose];
    if (!def.withdrawable)
      throw badRequest(
        'Ce point ne se retire pas ici : pour arrêter le traitement de vos données, écrivez à l’association (voir la politique de confidentialité).',
      );
    if (purpose === 'NOTIFICATIONS' && granted)
      throw badRequest(
        'Les notifications s’activent depuis l’appareil concerné (bouton « Activer »).',
      );
    return db.transaction(async (tx) => {
      const [m] = await tx.select().from(member).where(eq(member.id, req.user!.id)).for('update');
      if (!m) throw notFound('Compte introuvable.');
      // A choice the sheet already holds but whose record is missing is recorded first, so that
      // its withdrawal leaves a trace (and the audit entry that goes with the change).
      const held = {
        NEWSLETTER: m.newsletterOptInAt !== null,
        IMAGE_RIGHTS: m.imageConsentAt !== null,
      }[purpose as 'NEWSLETTER' | 'IMAGE_RIGHTS'];
      if (held)
        await recordConsent(tx, req, {
          memberId: m.id,
          purpose,
          granted: true,
          channel: 'MIGRATION',
        });
      if (purpose === 'EMAIL_RECEIPTS') {
        await tx.update(member).set({ ticketEmailOptOut: !granted }).where(eq(member.id, m.id));
      } else if (purpose === 'NEWSLETTER') {
        if (granted !== (m.newsletterOptInAt !== null))
          await tx
            .update(member)
            .set({ newsletterOptInAt: granted ? new Date() : null })
            .where(eq(member.id, m.id));
      } else if (purpose === 'IMAGE_RIGHTS') {
        if (granted !== (m.imageConsentAt !== null))
          await tx
            .update(member)
            .set({ imageConsentAt: granted ? new Date() : null })
            .where(eq(member.id, m.id));
      } else if (purpose === 'NOTIFICATIONS') {
        await tx.delete(pushSubscription).where(eq(pushSubscription.memberId, m.id));
      }
      await recordConsent(tx, req, {
        memberId: m.id,
        purpose,
        granted,
        channel: 'SELF_SERVICE',
      });
      return consentSummary(tx, m.id);
    });
  });
};
