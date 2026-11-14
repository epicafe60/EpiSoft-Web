import { and, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  loginLog,
  member,
  tillCashierProof,
  tillPinAttempt,
  userRole,
  type Db,
  type DbOrTx,
} from '@episoft/db';
import {
  LOCKOUT_LOOKBACK_MINUTES,
  PIN_LOCK_SECONDS,
  lockedUntil,
  pinLockedUntil,
  tillPinMatches,
  type CashierCheck,
} from '@episoft/shared';
import { loadSettings } from '../modules/admin/settings-store';
import { HttpProblem, badRequest, forbidden } from './problem';
import { verifyPassword } from './tokens';

// R-SES-07: the cashier of the till, when it is not the person signed in.

/**
 * The password of a member, typed at the till (to come back to one's account, or to choose one's
 * cashier code). It counts like a sign-in attempt: the same lockout (R-AUTH-03) applies, and a
 * wrong password is recorded in the sign-in history.
 */
export async function checkMemberPassword(
  db: Db,
  req: FastifyRequest,
  memberId: string,
  password: string,
): Promise<void> {
  const [m] = await db
    .select({ username: member.username, passwordHash: member.passwordHash })
    .from(member)
    .where(eq(member.id, memberId));
  if (!m) throw badRequest('Membre introuvable.');
  const now = new Date();
  const attempts = await db
    .select({ at: loginLog.at, success: loginLog.success })
    .from(loginLog)
    .where(
      and(
        or(
          eq(loginLog.memberId, memberId),
          m.username ? sql`lower(${loginLog.username}) = lower(${m.username})` : undefined,
        ),
        gt(loginLog.at, new Date(now.getTime() - LOCKOUT_LOOKBACK_MINUTES * 60_000)),
      ),
    );
  const locked = lockedUntil(attempts, now);
  if (locked)
    throw new HttpProblem(
      429,
      'Mot de passe bloqué',
      `Trop d’échecs. Réessayez dans ${Math.ceil((locked.getTime() - now.getTime()) / 60_000)} min.`,
    );
  const ok = m.passwordHash ? await verifyPassword(m.passwordHash, password) : false;
  if (ok) {
    // A right password closes the series of failures, as a sign-in does (otherwise the failures
    // of last week would still count towards the next lockout).
    await db.insert(loginLog).values({
      memberId,
      username: m.username,
      ip: req.ip,
      device: 'Caisse : mot de passe vérifié',
      success: true,
    });
    return;
  }
  await db.insert(loginLog).values({
    memberId,
    username: m.username,
    ip: req.ip,
    device: 'Caisse : mot de passe vérifié',
    success: false,
  });
  throw new HttpProblem(401, 'Mot de passe incorrect', 'Mot de passe incorrect.');
}

/** Who may keep the till: an active member with the CAISSE role. */
export async function assertCashier(db: DbOrTx, cashierId: string): Promise<void> {
  const [row] = await db
    .select({ status: member.status })
    .from(member)
    .innerJoin(userRole, and(eq(userRole.memberId, member.id), eq(userRole.roleCode, 'CAISSE')))
    .where(eq(member.id, cashierId));
  if (!row || row.status === 'INACTIVE' || row.status === 'ARCHIVED')
    throw forbidden('Ce bénévole n’a pas le rôle Caisse.');
}

/**
 * Wrong codes are counted in the database (they survive a restart of the API). The lock is per
 * signed-in person AND cashier: someone guessing the code of a colleague locks only their own
 * attempts, never the colleague's own use of their code. A ceiling per cashier whoever tries
 * (PIN_GLOBAL_MAX in PIN_GLOBAL_MINUTES) stops guessing spread over several accounts.
 */
export const PIN_GLOBAL_MAX = 20;
export const PIN_GLOBAL_MINUTES = 15;

export async function resetPinFailures(db: DbOrTx, cashierId?: string): Promise<void> {
  await db
    .delete(tillPinAttempt)
    .where(cashierId ? eq(tillPinAttempt.cashierId, cashierId) : undefined);
}

/** How long a proof of the code stays valid for the tickets that carry it (offline queues). */
export const PROOF_VALID_HOURS = 36;

/**
 * R-SES-07: the cashier typed their code, and the SERVER checks it (it never leaves the server: the
 * till does not hold a copy to check offline). Returns the check, and the proof the till attaches to
 * its tickets. DECLARED when the cashier has no code yet (never blocked, flagged).
 */
export async function checkCashierPin(
  db: Db,
  holderId: string,
  cashierId: string,
  pin: string | undefined,
  /** Called when the ceiling of wrong codes for this cashier is reached, with their number. */
  onGuessing?: (wrongCodes: number) => void,
): Promise<{ check: CashierCheck; proof: string | null }> {
  const [m] = await db
    .select({ hash: member.tillPasswordHash, salt: member.tillPasswordSalt })
    .from(member)
    .where(eq(member.id, cashierId));
  const stored = m?.hash && m.salt ? { hash: m.hash, salt: m.salt } : null;
  const required = (await loadSettings(db))['pos.cashierSwitch'].requirePin;
  if (!stored || (!required && pin === undefined)) return { check: 'DECLARED', proof: null };
  const now = new Date();
  const recent = await db
    .select({ at: tillPinAttempt.at })
    .from(tillPinAttempt)
    .where(
      and(
        eq(tillPinAttempt.cashierId, cashierId),
        eq(tillPinAttempt.holderId, holderId),
        gt(tillPinAttempt.at, new Date(now.getTime() - PIN_LOCK_SECONDS * 1000)),
      ),
    )
    .orderBy(tillPinAttempt.at);
  const [spread] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tillPinAttempt)
    .where(
      and(
        eq(tillPinAttempt.cashierId, cashierId),
        gt(tillPinAttempt.at, new Date(now.getTime() - PIN_GLOBAL_MINUTES * 60_000)),
      ),
    );
  if (spread!.n >= PIN_GLOBAL_MAX) {
    // F1: guessing a 4-digit code spread over several accounts: the caller tells the administrators
    // (once an hour, see alertNow) and it shows in « À surveiller » (admin/attention.ts).
    onGuessing?.(spread!.n);
    throw new HttpProblem(
      429,
      'Code bloqué',
      'Trop de codes faux pour ce caissier : réessayez dans quelques minutes.',
      undefined,
      'PIN_LOCKED',
    );
  }
  if (
    pinLockedUntil(
      recent.map((r) => r.at),
      now,
    )
  )
    throw new HttpProblem(
      429,
      'Code bloqué',
      'Trop de codes faux : réessayez dans une minute.',
      undefined,
      'PIN_LOCKED',
    );
  if (pin !== undefined && (await tillPinMatches(pin, stored))) {
    await db
      .delete(tillPinAttempt)
      .where(and(eq(tillPinAttempt.cashierId, cashierId), eq(tillPinAttempt.holderId, holderId)));
    const [proof] = await db
      .insert(tillCashierProof)
      .values({ holderId, cashierId })
      .returning({ id: tillCashierProof.id });
    // The proofs only matter for the tickets of the last day or so.
    await db
      .delete(tillCashierProof)
      .where(
        lt(tillCashierProof.issuedAt, new Date(now.getTime() - 4 * PROOF_VALID_HOURS * 3_600_000)),
      );
    return { check: 'PIN', proof: proof!.id };
  }
  await db.insert(tillPinAttempt).values({ cashierId, holderId });
  await db
    .delete(tillPinAttempt)
    .where(lt(tillPinAttempt.at, new Date(now.getTime() - 24 * 3_600_000)));
  throw new HttpProblem(
    403,
    'Code caissier incorrect',
    'Code caissier incorrect.',
    undefined,
    'PIN_WRONG',
  );
}

/**
 * Whether the proof a till attached to an operation was really issued by this server, to this
 * person for this cashier, recently. The claim « PIN » of the till alone is worth nothing.
 */
export async function proofIsValid(
  db: DbOrTx,
  holderId: string,
  cashierId: string,
  proof: string | undefined,
): Promise<boolean> {
  if (!proof) return false;
  const [row] = await db
    .select({ id: tillCashierProof.id })
    .from(tillCashierProof)
    .where(
      and(
        eq(tillCashierProof.id, proof),
        eq(tillCashierProof.holderId, holderId),
        eq(tillCashierProof.cashierId, cashierId),
        gt(tillCashierProof.issuedAt, new Date(Date.now() - PROOF_VALID_HOURS * 3_600_000)),
      ),
    );
  return !!row;
}
