import fp from 'fastify-plugin';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { member, session, userRole, type Db } from '@episoft/db';
import {
  CSRF_HEADER,
  hasAnyRole,
  ROLE_CODES,
  SESSION_TTL_HOURS,
  type RoleCode,
} from '@episoft/shared';
import type { Config } from '../config';
import { forbidden, HttpProblem, unauthorized } from '../lib/problem';
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
  /**
   * R-SES-07: another cashier keeps the till with this session: it reaches the till's routes
   * only, until the holder types their password again (POST /auth/unlock).
   */
  tillCashierId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
  interface FastifyContextConfig {
    /** Route reachable without a session (login, password reset, health). */
    public?: boolean;
    /**
     * R-SES-07: route the till uses, still reachable while another cashier keeps the till with
     * the session (every other route answers 403 TILL_LOCKED).
     */
    till?: boolean;
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

const GUARDED_ROLES = Symbol('guardedRoles');

/** The roles a route requires, read on its preHandler hooks; null when it requires none. */
export function guardedRoles(preHandler: unknown): RoleCode[] | null {
  const hooks = Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [];
  const found = hooks.flatMap((h) => (h as { [GUARDED_ROLES]?: RoleCode[] })[GUARDED_ROLES] ?? []);
  return found.length ? found : null;
}

/**
 * Whether the request targets the API. Decided on the route the router matched (its template, e.g.
 * `/api/v1/media/:id`) and on the decoded path, never on the raw URL: `/%61pi/v1/…` is routed like
 * `/api/v1/…`, so a test on the raw text would let it skip the protections (audit KV2, S01).
 */
export function isApiRequest(req: FastifyRequest): boolean {
  if (req.routeOptions.url?.startsWith('/api/')) return true;
  const raw = req.url.split('?')[0]!;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // A malformed encoding is never trusted as « not the API ».
    return true;
  }
  return path.toLowerCase().startsWith('/api/');
}

export default fp<{ db: Db; config: Config }>(async (app, { db, config }) => {
  const cookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
  };

  app.decorateRequest('user', null);

  // Both checks run as soon as the request is routed, before its body is read: a request without
  // a session never gets an upload buffered nor its body validated. The session is resolved here
  // too, so that the rate limit (a route hook, run after these) counts per real session, never
  // per cookie value sent by the client.
  app.addHook('onRequest', async (req) => {
    const api = isApiRequest(req);
    // §5.5 CSRF: state-changing API calls must carry a custom header. Browsers cannot add it
    // cross-site without a CORS preflight, which this API never grants.
    if (api && !SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== '1')
      throw forbidden('En-tête anti-CSRF manquant.');
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.user = await loadUser(db, hashToken(token));
    // Deny by default (R-AUTH-06): only routes marked public skip it.
    if (api && !req.routeOptions.config.public && !req.user) throw unauthorized();
    // R-SES-07: while another cashier keeps the till, the holder's rights stay out of reach.
    if (
      api &&
      req.user?.tillCashierId &&
      !req.routeOptions.config.public &&
      !req.routeOptions.config.till
    )
      throw new HttpProblem(
        403,
        'Caisse tenue par un autre caissier',
        'La caisse est tenue par un autre caissier : la personne connectée retape son mot de passe pour revenir au reste de l’application.',
        undefined,
        'TILL_LOCKED',
      );
  });

  app.decorate('requireRoles', (...roles: RoleCode[]): preHandlerHookHandler => {
    const guard: preHandlerHookHandler = async (req) => {
      if (!req.user) throw unauthorized();
      if (!hasAnyRole(req.user.roles, roles)) throw forbidden();
    };
    // Read back by the inventory of the routes (test/route-access.test.ts).
    return Object.assign(guard, { [GUARDED_ROLES]: roles });
  });

  app.decorate('startSession', async (reply, req, memberId, loginLogId) => {
    // A session cookie the browser already carried (another account, or one planted by someone
    // else) ends here: a sign-in always gets a fresh session, never reuses one.
    const previous = req.cookies[SESSION_COOKIE];
    if (previous) await db.delete(session).where(eq(session.id, hashToken(previous)));
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
      tillCashierId: session.tillCashierId,
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
  const tillCashierId = s.tillCashierId;
  if (!s.actingAsId) return { ...real, sessionId, impersonator: null, tillCashierId };
  // Impersonation holds only while the real person is still an administrator.
  const target = real.roles.includes('ADMIN') ? await loadMember(db, s.actingAsId) : null;
  if (!target) return { ...real, sessionId, impersonator: null, tillCashierId };
  return {
    ...target,
    sessionId,
    impersonator: { id: real.id, firstName: real.firstName, lastName: real.lastName },
    tillCashierId,
  };
}

async function loadMember(
  db: Db,
  memberId: string,
): Promise<Omit<AuthUser, 'sessionId' | 'impersonator' | 'tillCashierId'> | null> {
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
