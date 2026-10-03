import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loginLog, member, passwordResetToken, session, type Db } from '@episoft/db';
import {
  forgotPasswordSchema,
  LOCKOUT_LOOKBACK_MINUTES,
  lockedUntil,
  loginSchema,
  PASSWORD_RESET_TTL_MINUTES,
  resetPasswordSchema,
  type Me,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { HttpProblem, badRequest } from '../../lib/problem';
import { escapeHtml, queueEmail } from '../../lib/mail';
import { hashPassword, hashToken, newToken, verifyDummy, verifyPassword } from '../../lib/tokens';
import { canLogIn } from '../../plugins/auth';
import type { DbOrTx } from '@episoft/db';

const INVALID_CREDENTIALS = 'Identifiant ou mot de passe incorrect.';

export const authRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  // §5.5: rate limiting on top of the per-username lockout (R-AUTH-03).
  const authRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.post(
    '/auth/login',
    { schema: { body: loginSchema }, config: { public: true, ...authRateLimit } },
    async (req, reply) => {
      const { username, password } = req.body;
      const now = new Date();

      const since = new Date(now.getTime() - LOCKOUT_LOOKBACK_MINUTES * 60_000);
      const attempts = await db
        .select({ at: loginLog.at, success: loginLog.success })
        .from(loginLog)
        .where(and(sql`lower(${loginLog.username}) = lower(${username})`, gt(loginLog.at, since)));
      const locked = lockedUntil(attempts, now);
      if (locked) {
        const minutes = Math.ceil((locked.getTime() - now.getTime()) / 60_000);
        throw new HttpProblem(
          429,
          'Connexion bloquée',
          `Trop d’échecs de connexion. Réessayez dans ${minutes} min.`,
        );
      }

      const user = await db.query.member.findFirst({
        where: sql`lower(${member.username}) = lower(${username})`,
        columns: { id: true, passwordHash: true, status: true },
      });
      let ok = false;
      if (user?.passwordHash) ok = await verifyPassword(user.passwordHash, password);
      else await verifyDummy(password);
      // An inactive member gets the same answer as a wrong password: nothing is revealed.
      if (ok && user && !canLogIn(user.status)) ok = false;

      const device = req.headers['user-agent']?.slice(0, 300) ?? null;
      const [log] = await db
        .insert(loginLog)
        .values({ memberId: user?.id ?? null, username, ip: req.ip, device, success: ok })
        .returning({ id: loginLog.id });
      if (!ok || !user) throw new HttpProblem(401, 'Connexion refusée', INVALID_CREDENTIALS);

      await app.startSession(reply, req, user.id, log!.id);
      return reply.status(204).send();
    },
  );

  app.post('/auth/logout', { config: { public: true } }, async (req, reply) => {
    const loginLogId = await app.endSession(reply, req);
    if (loginLogId) {
      await db.update(loginLog).set({ logoutAt: new Date() }).where(eq(loginLog.id, loginLogId));
    }
    return reply.status(204).send();
  });

  app.get('/me', async (req): Promise<Me> => {
    const u = req.user!;
    return {
      id: u.id,
      number: u.number,
      firstName: u.firstName,
      lastName: u.lastName,
      username: u.username,
      roles: u.roles,
      impersonator: u.impersonator,
    };
  });

  // R-AUTH-02. Always answers 204 so the endpoint does not reveal which usernames exist.
  app.post(
    '/auth/password/forgot',
    { schema: { body: forgotPasswordSchema }, config: { public: true, ...authRateLimit } },
    async (req, reply) => {
      const user = await db.query.member.findFirst({
        where: sql`lower(${member.username}) = lower(${req.body.username})`,
        columns: { id: true, email: true, firstName: true, status: true },
      });
      if (user?.email && canLogIn(user.status)) {
        await db.transaction((tx) => sendPasswordLink(tx, config, user));
      } else {
        req.log.info(
          { username: req.body.username },
          'mot de passe oublié : pas de compte ou pas de courriel',
        );
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/auth/password/reset',
    { schema: { body: resetPasswordSchema }, config: { public: true, ...authRateLimit } },
    async (req, reply) => {
      const id = hashToken(req.body.token);
      const passwordHash = await hashPassword(req.body.password);
      await db.transaction(async (tx) => {
        const [token] = await tx
          .update(passwordResetToken)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(passwordResetToken.id, id),
              isNull(passwordResetToken.usedAt),
              gt(passwordResetToken.expiresAt, new Date()),
            ),
          )
          .returning({ memberId: passwordResetToken.memberId });
        if (!token) throw badRequest('Ce lien n’est plus valide. Demandez-en un nouveau.');
        await tx.update(member).set({ passwordHash }).where(eq(member.id, token.memberId));
        // A new password closes every open session of the member.
        await tx.delete(session).where(eq(session.memberId, token.memberId));
        await audit(tx, req, {
          action: 'password.reset',
          entity: 'member',
          entityId: token.memberId,
        });
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/health',
    { config: { public: true }, schema: { response: { 200: z.object({ ok: z.boolean() }) } } },
    async () => {
      await db.execute(sql`select 1`);
      return { ok: true };
    },
  );
};

/**
 * Creates a one-hour reset token and queues the e-mail when the member has an address.
 * Returns the link (printed by the CLI).
 */
export async function sendPasswordLink(
  tx: DbOrTx,
  config: Config,
  user: { id: string; email: string | null; firstName: string },
): Promise<string> {
  const token = newToken();
  await tx.insert(passwordResetToken).values({
    id: hashToken(token),
    memberId: user.id,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
  });
  const link = `${config.APP_URL}/mot-de-passe?jeton=${encodeURIComponent(token)}`;
  if (!user.email) return link;
  await queueEmail(tx, {
    to: user.email,
    subject: 'Épicafé : définir votre mot de passe',
    text: `Bonjour ${user.firstName},\n\nPour définir votre mot de passe EpiSoft, ouvrez ce lien (valable 1 heure) :\n${link}\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.`,
    html: `<p>Bonjour ${escapeHtml(user.firstName)},</p><p>Pour définir votre mot de passe EpiSoft, ouvrez ce lien (valable 1&nbsp;heure)&nbsp;:<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.</p>`,
  });
  return link;
}
