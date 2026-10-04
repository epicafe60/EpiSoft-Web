import { z } from 'zod';
import { ROLE_CODES, type RoleCode } from './roles';

// Shapes exchanged between the API and the web app.

export const MEMBER_STATUSES = ['NEW', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  NEW: 'Nouveau',
  ACTIVE: 'Actif',
  INACTIVE: 'Inactif',
  ARCHIVED: 'Archivé',
};

/** Legacy `MBRESTATUT` 0–3 (spec §6.3). */
export function memberStatusFromLegacy(v: number | null | undefined): MemberStatus | null {
  return MEMBER_STATUSES[v ?? -1] ?? null;
}

export interface Me {
  id: string;
  number: number;
  firstName: string;
  lastName: string;
  username: string;
  roles: RoleCode[];
  /** Set while an administrator acts as this user (impersonation). */
  impersonator?: { id: string; firstName: string; lastName: string } | null;
}

export const roleCodeSchema = z.enum(ROLE_CODES);

export const setUserRolesSchema = z.object({
  roles: z.array(roleCodeSchema).max(ROLE_CODES.length),
});

export interface UserSummary {
  id: string;
  number: number;
  firstName: string;
  lastName: string;
  username: string | null;
  status: MemberStatus;
  hasPassword: boolean;
  roles: RoleCode[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorName: string | null;
  /** Set when an administrator was impersonating this member. */
  onBehalfOfName?: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

export const auditQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  /** Everything about a person: what they did, what was done on their behalf, and edits of their record. */
  memberId: z.string().uuid().optional(),
  entity: z.string().max(50).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  /** Id of the last entry already shown (UUID v7 ids are time-ordered). */
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** RFC 9457 problem details (spec §8.1). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

/** Every state-changing request must carry this header (CSRF protection, spec §5.5). */
export const CSRF_HEADER = 'x-episoft-csrf';
