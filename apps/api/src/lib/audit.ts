import type { FastifyRequest } from 'fastify';
import { auditLog, type DbOrTx } from '@episoft/db';
import type { AuditAction } from '@episoft/shared';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set once the request has recorded an action (a file download then needs no extra entry). */
    audited?: boolean;
  }
}

export interface AuditInput {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Set by an « annulation »: the journal entry it undoes. */
  revertsId?: string | null;
  /** The person, when the request is not signed in yet (log-in, forgotten password). */
  actorId?: string;
}

/**
 * Spec principle 8, R-ADM-02 and R-ADM-05: who, when, before, after.
 * Call it inside the same transaction as the change it records: the entry then carries the
 * transaction id, which links it to every row the change touched (data_change).
 */
export async function audit(db: DbOrTx, req: FastifyRequest, input: AuditInput): Promise<void> {
  req.audited = true;
  await db.insert(auditLog).values({
    // While an administrator impersonates someone, the real person is the actor.
    actorId: req.user?.impersonator?.id ?? req.user?.id ?? input.actorId ?? null,
    onBehalfOfId: req.user?.impersonator ? req.user.id : null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    ip: req.ip,
    revertsId: input.revertsId ?? null,
  });
}

/** An action of the application itself (a background job): no person, no address. */
export async function auditSystem(
  db: DbOrTx,
  input: Omit<AuditInput, 'revertsId' | 'actorId'>,
): Promise<void> {
  await db.insert(auditLog).values({
    actorId: null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
  });
}
