import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditLog, loginLog, member, setting, userRole, type Db } from '@episoft/db';
import {
  auditQuerySchema,
  isSettingKey,
  normalizeSearch,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  settingSchemas,
  setUserRolesSchema,
  type AuditEntry,
  type MemberStatus,
  type RoleCode,
  type Settings,
  type UserSummary,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { sendPasswordLink } from '../auth/routes';
import { loadSettings } from './settings-store';

export const adminRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const admin = { preHandler: app.requireRoles('ADMIN') };

  // --- Settings (R-ADM-01) -------------------------------------------------

  app.get('/settings', admin, async (): Promise<Settings> => loadSettings(db));

  app.put(
    '/settings/:key',
    { ...admin, schema: { params: z.object({ key: z.string() }), body: z.unknown() } },
    async (req) => {
      const { key } = req.params;
      if (!isSettingKey(key)) throw notFound(`Paramètre inconnu : ${key}`);
      const parsed = settingSchemas[key].safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          'Certaines valeurs sont invalides.',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }
      const value = parsed.data;
      await db.transaction(async (tx) => {
        const [before] = await tx.select().from(setting).where(eq(setting.key, key)).for('update');
        await tx
          .insert(setting)
          .values({ key, value, updatedBy: req.user!.id })
          .onConflictDoUpdate({
            target: setting.key,
            set: { value, updatedBy: req.user!.id, updatedAt: new Date() },
          });
        await audit(tx, req, {
          action: 'setting.update',
          entity: 'setting',
          entityId: key,
          before: before?.value ?? null,
          after: value,
        });
      });
      return value;
    },
  );

  // --- Users and roles (R-AUTH-05, §4.1 "j'attribue des rôles") ------------

  app.get(
    '/admin/users',
    {
      ...admin,
      schema: {
        querystring: z.object({
          q: z.string().max(100).optional(),
          withRoles: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (req): Promise<UserSummary[]> => {
      const filters: SQL[] = [];
      const q = req.query.q ? normalizeSearch(req.query.q) : '';
      if (q) {
        // R-MBR-06 accent-insensitive search; unaccent is not installed, so translate common letters.
        const fold = (col: SQL | AnyColumn) =>
          sql`translate(lower(${col}), 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœ', 'aaaaaaceeeeiiiinooooouuuuyyo')`;
        const like = `%${q}%`;
        const asNumber = /^\d+$/.test(q) ? Number(q) : null;
        filters.push(
          or(
            sql`${fold(member.lastName)} like ${like}`,
            sql`${fold(member.firstName)} like ${like}`,
            sql`${fold(sql`${member.firstName} || ' ' || ${member.lastName}`)} like ${like}`,
            ilike(member.username, like),
            ilike(member.email, like),
            asNumber !== null ? eq(member.number, asNumber) : undefined,
          )!,
        );
      }
      if (req.query.withRoles === 'true') {
        filters.push(
          sql`exists (select 1 from ${userRole} where ${userRole.memberId} = ${member.id})`,
        );
      }
      const members = await db
        .select({
          id: member.id,
          number: member.number,
          firstName: member.firstName,
          lastName: member.lastName,
          username: member.username,
          status: member.status,
          hasPassword: sql<boolean>`${member.passwordHash} is not null`,
        })
        .from(member)
        .where(and(...filters))
        .orderBy(member.lastName, member.firstName)
        .limit(200);
      const roles = members.length
        ? await db
            .select()
            .from(userRole)
            .where(
              inArray(
                userRole.memberId,
                members.map((m) => m.id),
              ),
            )
        : [];
      return members.map((m) => ({
        ...m,
        status: m.status as MemberStatus,
        roles: roles.filter((r) => r.memberId === m.id).map((r) => r.roleCode as RoleCode),
      }));
    },
  );

  app.put(
    '/admin/users/:id/roles',
    { ...admin, schema: { params: z.object({ id: z.string().uuid() }), body: setUserRolesSchema } },
    async (req) => {
      const { id } = req.params;
      const next = [...new Set(req.body.roles)];
      await db.transaction(async (tx) => {
        const target = await tx.query.member.findFirst({
          where: eq(member.id, id),
          columns: { id: true },
        });
        if (!target) throw notFound('Membre introuvable.');
        // Serialize role changes so two admins cannot remove the last ADMIN concurrently.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('user_role'))`);
        const before = (await tx.select().from(userRole).where(eq(userRole.memberId, id))).map(
          (r) => r.roleCode,
        );
        if (before.includes('ADMIN') && !next.includes('ADMIN')) {
          const [{ admins }] = (await tx
            .select({ admins: sql<number>`count(*)::int` })
            .from(userRole)
            .where(eq(userRole.roleCode, 'ADMIN'))) as [{ admins: number }];
          if (admins <= 1) throw conflict('Il doit rester au moins un administrateur.');
        }
        await tx.delete(userRole).where(eq(userRole.memberId, id));
        if (next.length)
          await tx.insert(userRole).values(next.map((roleCode) => ({ memberId: id, roleCode })));
        // The till refreshes members by updated_at: a new cashier must reach it (R-OFF-02).
        await tx.update(member).set({ updatedAt: new Date() }).where(eq(member.id, id));
        await audit(tx, req, {
          action: 'member.roles',
          entity: 'member',
          entityId: id,
          before: { roles: before },
          after: { roles: next },
        });
      });
      return { roles: next };
    },
  );

  app.post(
    '/admin/users/:id/password-link',
    { ...admin, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      await db.transaction(async (tx) => {
        const user = await tx.query.member.findFirst({
          where: eq(member.id, req.params.id),
          columns: { id: true, email: true, firstName: true, username: true },
        });
        if (!user) throw notFound('Membre introuvable.');
        if (!user.email) throw badRequest('Ce membre n’a pas d’adresse électronique.');
        if (!user.username) throw badRequest('Ce membre n’a pas d’identifiant de connexion.');
        await sendPasswordLink(tx, config, user);
        await audit(tx, req, { action: 'password.link', entity: 'member', entityId: user.id });
      });
      return reply.status(204).send();
    },
  );

  // --- Audit log (R-ADM-02) and login log (R-AUTH-07) ---------------------

  app.get(
    '/audit',
    { ...admin, schema: { querystring: auditQuerySchema } },
    async (req): Promise<AuditEntry[]> => {
      const q = req.query;
      const filters: SQL[] = [];
      if (q.actorId) filters.push(eq(auditLog.actorId, q.actorId));
      if (q.entity) filters.push(eq(auditLog.entity, q.entity));
      if (q.from) filters.push(gte(auditLog.at, sql`${q.from}::date`));
      if (q.to) filters.push(lt(auditLog.at, sql`${q.to}::date + 1`));
      if (q.cursor) filters.push(lt(auditLog.id, q.cursor));
      const rows = await db
        .select({
          id: auditLog.id,
          at: auditLog.at,
          actorId: auditLog.actorId,
          actorName: sql<string | null>`${member.firstName} || ' ' || ${member.lastName}`,
          action: auditLog.action,
          entity: auditLog.entity,
          entityId: auditLog.entityId,
          before: auditLog.before,
          after: auditLog.after,
          ip: auditLog.ip,
        })
        .from(auditLog)
        .leftJoin(member, eq(member.id, auditLog.actorId))
        .where(and(...filters))
        .orderBy(desc(auditLog.id))
        .limit(q.limit);
      return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
    },
  );

  app.get(
    '/admin/logins',
    {
      ...admin,
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
    },
    async (req) => {
      const rows = await db
        .select({
          id: loginLog.id,
          at: loginLog.at,
          username: loginLog.username,
          memberName: sql<string | null>`${member.firstName} || ' ' || ${member.lastName}`,
          success: loginLog.success,
          ip: loginLog.ip,
          device: loginLog.device,
          logoutAt: loginLog.logoutAt,
        })
        .from(loginLog)
        .leftJoin(member, eq(member.id, loginLog.memberId))
        .orderBy(desc(loginLog.at))
        .limit(req.query.limit);
      return rows.map((r) => ({
        ...r,
        at: r.at.toISOString(),
        logoutAt: r.logoutAt?.toISOString() ?? null,
      }));
    },
  );
};
