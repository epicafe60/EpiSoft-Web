import fp from 'fastify-plugin';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, preHandlerHookHandler } from 'fastify';
import { member, session, userRole, type Db } from '@episoft/db';
import {
  CSRF_HEADER,
  hasAnyRole,
  ROLE_CODES,
  SESSION_TTL_HOURS,
  type RoleCode,
} from '@episoft/shared';
import type { Config } from '../config';
import { forbidden, unauthorized } from '../lib/problem';
import { hashToken, newToken } from '../lib/tokens';

export const SESSION_COOKIE = 'episoft_session';

export interface AuthUser {
  id: string;
  number: number;
  firstName: string;
  lastName: string;
  username: string;
  roles: RoleCode[];
  sessionId: string;
  /** Set while an administrator acts as this user (impersonation): the real person. */
  impersonator: { id: string; firstName: string; lastName: string } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
  interface FastifyContextConfig {
    /** Route reachable without a session (login, password reset, health). */
    public?: boolean;
  }
  interface FastifyInstance {
    requireRoles(...roles: RoleCode[]): preHandlerHookHandler;
    startSession(
      reply: FastifyReply,
      req: FastifyRequest,
      memberId: string,
      loginLogId: string,
    ): Promise<void>;
    endSession(reply: FastifyReply, req: FastifyRequest): Promise<string | null>;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export default fp<{ db: Db; config: Config }>(async (app, { db, config }) => {
  const cookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
  };

  app.decorateRequest('user', null);

  // §5.5 CSRF: state-changing API calls must carry a custom header. Browsers cannot add it
  // cross-site without a CORS preflight, which this API never grants.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || SAFE_METHODS.has(req.method)) return;
    if (req.headers[CSRF_HEADER] !== '1') throw forbidden('En-tête anti-CSRF manquant.');
  });

  // Resolve the session, then deny by default (R-AUTH-06): only routes marked public skip it.
  app.addHook('preHandler', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.user = await loadUser(db, hashToken(token));
    if (!req.routeOptions.config.public && req.url.startsWith('/api/') && !req.user) {
      throw unauthorized();
    }
  });

  app.decorate('requireRoles', (...roles: RoleCode[]): preHandlerHookHandler => {
    return async (req) => {
      if (!req.user) throw unauthorized();
      if (!hasAnyRole(req.user.roles, roles)) throw forbidden();
    };
  });

  app.decorate('startSession', async (reply, req, memberId, loginLogId) => {
    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
    await db.insert(session).values({
      id: hashToken(token),
      memberId,
      expiresAt,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      loginLogId,
    });
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
  });

  app.decorate('endSession', async (reply, req) => {
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    const [ended] = await db
      .delete(session)
      .where(eq(session.id, hashToken(token)))
      .returning({ loginLogId: session.loginLogId });
    return ended?.loginLogId ?? null;
  });
});

async function loadUser(db: Db, sessionId: string): Promise<AuthUser | null> {
  const [s] = await db
    .select({
      memberId: session.memberId,
      actingAsId: session.actingAsId,
      lastSeenAt: session.lastSeenAt,
    })
    .from(session)
    .where(and(eq(session.id, sessionId), gt(session.expiresAt, new Date())));
  if (!s) return null;
  // Who is connected (R-SES-06): the time of the last request, noted at most once a minute.
  if (Date.now() - s.lastSeenAt.getTime() > 60_000)
    await db.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, sessionId));
  const real = await loadMember(db, s.memberId);
  if (!real) return null;
  if (!s.actingAsId) return { ...real, sessionId, impersonator: null };
  // Impersonation holds only while the real person is still an administrator.
  const target = real.roles.includes('ADMIN') ? await loadMember(db, s.actingAsId) : null;
  if (!target) return { ...real, sessionId, impersonator: null };
  return {
    ...target,
    sessionId,
    impersonator: { id: real.id, firstName: real.firstName, lastName: real.lastName },
  };
}

async function loadMember(
  db: Db,
  memberId: string,
): Promise<Omit<AuthUser, 'sessionId' | 'impersonator'> | null> {
  const rows = await db
    .select({
      id: member.id,
      number: member.number,
      firstName: member.firstName,
      lastName: member.lastName,
      username: member.username,
      status: member.status,
      role: userRole.roleCode,
    })
    .from(member)
    .leftJoin(userRole, eq(userRole.memberId, member.id))
    .where(eq(member.id, memberId));
  const first = rows[0];
  // A member deactivated after logging in loses access immediately.
  if (!first || !first.username || !canLogIn(first.status)) return null;
  return {
    id: first.id,
    number: first.number,
    firstName: first.firstName,
    lastName: first.lastName,
    username: first.username,
    roles: ROLE_CODES.filter((code) => rows.some((r) => r.role === code)),
  };
}

/** Inactive and archived members cannot log in (R-MBR-03 applied to the back-office). */
export function canLogIn(status: string): boolean {
  return status === 'NEW' || status === 'ACTIVE';
}
