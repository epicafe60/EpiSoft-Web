import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditLog, priceHistory, product, type Db, type Tx } from '@episoft/db';
import {
  describeAudit,
  type RestoreStep,
  type RevertPreview,
  type RowChange,
} from '@episoft/shared';
import type { Config } from '../../../config';
import { audit } from '../../../lib/audit';
import { HttpProblem, conflict, notFound } from '../../../lib/problem';
import { safeErrorMessage } from '../../../plugins/errors';
import { policyFor, type Policy, type RevertContext } from './policies';
import { applyRestore, prepareRestore, type PreparedRestore } from './restore';

// R-ADM-06: « Annuler cette action » from the journal, for the administrators. The preview runs
// the undo for real in a transaction that is then rolled back, so what it announces (including a
// refusal of the database) is exactly what the confirmation will do.

const idParams = { params: z.object({ id: z.string().uuid() }) };

interface Entry {
  id: string;
  action: string;
  at: Date;
  after: unknown;
  xact: string | null;
  actorName: string | null;
}

class DryRun extends Error {}

/** The undo of an entry, if one is in effect (an undo itself undone does not count). */
async function revertOf(db: Db | Tx, entry: Entry) {
  if (!entry.xact) return null;
  const { rows } = await db.execute<{ id: string; at: Date; actor_name: string | null }>(sql`
    select r.id, r.at, m.first_name || ' ' || m.last_name as actor_name
    from app.audit_log r
    join app.audit_log o on o.id = r.reverts_id
    left join app.member m on m.id = r.actor_id
    where o.xact = ${entry.xact}::xid8
      and not exists (select 1 from app.audit_log rr where rr.reverts_id = r.id)
    order by r.at desc limit 1`);
  const r = rows[0];
  return r ? { id: r.id, at: new Date(r.at).toISOString(), actorName: r.actor_name } : null;
}

export const revertRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const admin = { preHandler: app.requireRoles('ADMIN') };

  const loadEntry = async (tx: Db | Tx, id: string): Promise<Entry> => {
    const { rows } = await tx.execute<{
      id: string;
      action: string;
      at: Date;
      after: unknown;
      xact: string | null;
      actor_name: string | null;
    }>(sql`select a.id, a.action, a.at, a.after, a.xact::text as xact,
                  m.first_name || ' ' || m.last_name as actor_name
           from app.audit_log a left join app.member m on m.id = a.actor_id
           where a.id = ${id}`);
    const r = rows[0];
    if (!r) throw notFound('Action introuvable dans le journal.');
    return { ...r, at: new Date(r.at), actorName: r.actor_name };
  };

  /** Other actions recorded in the same transaction: undone together. */
  const siblings = async (tx: Db | Tx, e: Entry) => {
    if (!e.xact) return [];
    const { rows } = await tx.execute<{ id: string; action: string; after: unknown }>(
      sql`select id, action, after from app.audit_log
          where xact = ${e.xact}::xid8 and id <> ${e.id} order by id`,
    );
    return rows.map((r) => ({ id: r.id, sentence: describeAudit(r.action, r.after) }));
  };

  /**
   * Runs the undo in `tx`: for the preview (then rolled back) or for real. Returns what the
   * preview shows; throws an HttpProblem when it cannot be done.
   */
  const run = async (
    tx: Tx,
    req: Parameters<typeof audit>[1],
    e: Entry,
    reason: string,
  ): Promise<{ policy: Policy; prepared: PreparedRestore | null; message: string }> => {
    if (!e.xact)
      throw conflict(
        'Cette action date d’avant l’enregistrement détaillé des modifications : elle ne peut pas être annulée d’ici.',
      );
    const done = await revertOf(tx, e);
    if (done)
      throw conflict(`Cette action a déjà été annulée par ${done.actorName ?? 'quelqu’un'}.`);
    const prepared = await prepareRestore(tx, e.xact);
    const ctx: RevertContext = { entry: e, changes: prepared.changes };
    const policy = policyFor(ctx);
    let message: string;
    if (policy.kind === 'none' || policy.kind === 'via') {
      return { policy, prepared: null, message: policy.reason };
    } else if (policy.kind === 'compensate') {
      message = await policy.run(tx, req, ctx, reason);
    } else {
      if (prepared.historyTables.length)
        return {
          policy: {
            kind: 'none',
            reason:
              'Cette action a enregistré des opérations de caisse, de stock ou de cagnotte : elles ne s’effacent pas. Refaites l’opération inverse depuis l’écran concerné.',
          },
          prepared,
          message: '',
        };
      if (prepared.plan.conflicts.length) return { policy, prepared, message: '' };
      if (!prepared.plan.steps.length)
        throw conflict('Il n’y a plus rien à remettre : les valeurs sont déjà celles d’avant.');
      await applyRestore(tx, prepared.plan.steps);
      await notePriceChanges(tx, req.user!.id, prepared.plan.steps);
      message = `${prepared.plan.steps.length} élément(s) remis comme avant.`;
    }
    await audit(tx, req, {
      action: 'audit.revert',
      entity: 'audit_log',
      entityId: e.id,
      revertsId: e.id,
      after: { reason, action: e.action, kind: policy.kind, message },
    });
    return { policy, prepared, message };
  };

  app.get('/admin/audit/:id/revert', { ...admin, schema: idParams }, async (req) => {
    const e = await loadEntry(db, req.params.id);
    const base = {
      entry: {
        id: e.id,
        at: e.at.toISOString(),
        actorName: e.actorName,
        sentence: describeAudit(e.action, e.after),
      },
      siblings: await siblings(db, e),
      revertedBy: await revertOf(db, e),
    };
    let preview: Omit<RevertPreview, keyof typeof base>;
    try {
      let outcome: Awaited<ReturnType<typeof run>> | undefined;
      await db
        .transaction(async (tx) => {
          outcome = await run(tx, req, e, 'aperçu');
          throw new DryRun();
        })
        .catch((err: unknown) => {
          if (!(err instanceof DryRun)) throw err;
        });
      const { policy, prepared, message } = outcome!;
      const conflicts = prepared?.conflictsBy ?? [];
      preview = {
        kind: policy.kind,
        possible: (policy.kind === 'restore' && !conflicts.length) || policy.kind === 'compensate',
        label:
          policy.kind === 'compensate'
            ? policy.label
            : policy.kind === 'restore'
              ? 'Remettre les valeurs d’avant'
              : null,
        reason: policy.kind === 'none' || policy.kind === 'via' ? policy.reason : null,
        link: policy.kind === 'via' ? policy.link : null,
        message: policy.kind === 'none' || policy.kind === 'via' ? null : message,
        steps: (prepared?.plan.steps ?? []).map((s) => ({
          table: s.table,
          kind: s.kind,
          values: s.kind === 'update' ? s.set : s.kind === 'insert' ? s.row : null,
          current: currentOf(prepared!, s.table, s.key),
        })),
        conflicts: conflicts.map((c) => ({
          table: c.table,
          kind: c.kind,
          columns: c.columns ?? [],
          by: c.by
            ? {
                auditId: c.by.auditId,
                at: c.by.at,
                actorName: c.by.actorName,
                sentence: c.by.action ? describeAudit(c.by.action) : null,
              }
            : null,
        })),
      };
    } catch (err) {
      if (err instanceof HttpProblem) preview = blocked(err.detail ?? err.message);
      else preview = blocked(databaseRefusal(err));
    }
    return { ...base, ...preview } satisfies RevertPreview;
  });

  app.post(
    '/admin/audit/:id/revert',
    {
      ...admin,
      schema: { ...idParams, body: z.object({ reason: z.string().trim().min(3).max(500) }) },
    },
    async (req) => {
      try {
        return await db.transaction(async (tx) => {
          // One undo at a time for a given action.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${'revert:' + req.params.id}))`,
          );
          const e = await loadEntry(tx, req.params.id);
          const { policy, prepared, message } = await run(tx, req, e, req.body.reason);
          if (policy.kind === 'none' || policy.kind === 'via') throw conflict(policy.reason);
          if (prepared?.plan.conflicts.length && policy.kind === 'restore')
            throw conflict(
              'Des éléments ont été modifiés depuis : annulez d’abord les actions plus récentes (voir l’aperçu).',
            );
          const [r] = await tx
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(eq(auditLog.revertsId, e.id))
            .orderBy(sql`${auditLog.at} desc`)
            .limit(1);
          return { id: r!.id, message };
        });
      } catch (err) {
        if (err instanceof HttpProblem) throw err;
        throw conflict(databaseRefusal(err));
      }
    },
  );

  /** Every row the action changed, as recorded by the database (« Détail technique »). */
  app.get('/admin/audit/:id/changes', { ...admin, schema: idParams }, async (req) => {
    const e = await loadEntry(db, req.params.id);
    if (!e.xact) return [];
    const { rows } = await db.execute<{
      id: string;
      at: Date;
      table_name: string;
      row_key: Record<string, unknown> | null;
      op: RowChange['op'];
      old: Record<string, unknown> | null;
      new: Record<string, unknown> | null;
    }>(sql`select id, at, table_name, row_key, op, old, new from app.data_change
           where xact = ${e.xact}::xid8 order by id limit 500`);
    return rows.map((r) => ({
      id: Number(r.id),
      at: new Date(r.at).toISOString(),
      table: r.table_name,
      key: r.row_key,
      op: r.op,
      old: r.old,
      new: r.new,
    }));
  });

  /**
   * R-ADM-07: changes no action of the journal accounts for (made by hand in the database, or by
   * the application without recording them), grouped by transaction.
   */
  app.get(
    '/admin/audit/unattributed',
    {
      ...admin,
      schema: {
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      },
    },
    async (req) => {
      const { rows } = await db.execute<{
        xact: string;
        at: Date;
        source: string | null;
        tables: string[];
        rows: number;
      }>(sql`
        select d.xact::text as xact, min(d.at) as at, min(d.source) as source,
               array_agg(distinct d.table_name order by d.table_name) as tables, count(*)::int as rows
        from app.data_change d
        where d.at > now() - make_interval(days => ${req.query.days})
          and (d.source is null or d.source = 'app')
          and d.table_name <> 'sync_receipt'
          and not exists (select 1 from app.audit_log a where a.xact = d.xact)
        group by d.xact order by min(d.at) desc limit 200`);
      return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    },
  );
};

const PRICE_COLUMNS = ['sale_price', 'purchase_price_excl', 'purchase_price_incl'];

/** R-PRD-05: a price put back is a price change too, dated in the price history. */
async function notePriceChanges(tx: Tx, userId: string, steps: RestoreStep[]) {
  for (const s of steps) {
    if (s.table !== 'product' || s.kind !== 'update') continue;
    if (!PRICE_COLUMNS.some((c) => c in s.set)) continue;
    const [p] = await tx
      .select()
      .from(product)
      .where(eq(product.id, String(s.key.id)));
    if (!p) continue;
    await tx.insert(priceHistory).values({
      productId: p.id,
      purchasePriceExcl: p.purchasePriceExcl,
      purchasePriceIncl: p.purchasePriceIncl,
      salePrice: p.salePrice,
      source: 'FORM',
      by: userId,
    });
  }
}

function currentOf(p: PreparedRestore, table: string, key: Record<string, unknown>) {
  // What the preview shows next to the values to put back: the values of the action.
  const after: Record<string, unknown> = {};
  for (const c of p.changes)
    if (c.table === table && JSON.stringify(c.key) === JSON.stringify(key))
      Object.assign(after, c.new ?? {});
  return Object.keys(after).length ? after : null;
}

function blocked(reason: string): Omit<RevertPreview, 'entry' | 'siblings' | 'revertedBy'> {
  return {
    kind: 'none',
    possible: false,
    label: null,
    reason,
    link: null,
    message: null,
    steps: [],
    conflicts: [],
  };
}

/** A refusal of the database, in words: the usual cases, else its first line. */
function databaseRefusal(err: unknown): string {
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code;
  if (code === '23503')
    return 'Un lien entre les données l’empêche : un élément créé par cette action est utilisé ailleurs depuis, ou un élément à recréer dépend d’un autre qui n’existe plus.';
  if (code === '23505')
    return 'Un élément identique existe de nouveau : le remettre créerait un doublon.';
  if (code === '23000')
    return 'La base refuse : une écriture comptable validée ne se modifie pas, elle se contre-passe.';
  return `La base refuse cette annulation : ${safeErrorMessage(err as Error)}`;
}
