import type { FastifyRequest } from 'fastify';
import { auditLog, type DbOrTx } from '@episoft/db';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Spec principle 8 and R-ADM-02: who, when, before, after.
 * Call it inside the same transaction as the change it records.
 */
export async function audit(db: DbOrTx, req: FastifyRequest, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    // While an administrator impersonates someone, the real person is the actor.
    actorId: req.user?.impersonator?.id ?? req.user?.id ?? null,
    onBehalfOfId: req.user?.impersonator ? req.user.id : null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    ip: req.ip,
  });
}
