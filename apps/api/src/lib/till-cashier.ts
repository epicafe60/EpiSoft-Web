import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { loginLog, member, userRole, type Db, type DbOrTx } from '@episoft/db';
import {
  LOCKOUT_LOOKBACK_MINUTES,
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

/**
 * Wrong cashier codes typed at the server (closing, change of cashier), per signed-in person AND
 * cashier: someone guessing the code of a colleague locks only their own attempts, never the
 * colleague's own use of their code.
 */
const pinFailures = new Map<string, Date[]>();

/** Exposed for the tests, which change the clock of the failures. */
export function resetPinFailures(): void {
  pinFailures.clear();
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
 * The cashier code checked by the server (online actions). Returns how the cashier is
 * established: PIN when the right code was typed, DECLARED when no code is required or the
 * cashier has none yet (R-SES-07: never blocked, flagged).
 */
export async function checkCashierPin(
  db: DbOrTx,
  holderId: string,
  cashierId: string,
  pin: string | undefined,
): Promise<CashierCheck> {
  const key = `${holderId}:${cashierId}`;
  const [m] = await db
    .select({ hash: member.tillPasswordHash, salt: member.tillPasswordSalt })
    .from(member)
    .where(eq(member.id, cashierId));
  const stored = m?.hash && m.salt ? { hash: m.hash, salt: m.salt } : null;
  const required = (await loadSettings(db))['pos.cashierSwitch'].requirePin;
  if (!stored || (!required && pin === undefined)) return 'DECLARED';
  const now = new Date();
  const failures = pinFailures.get(key) ?? [];
  const locked = pinLockedUntil(failures, now);
  if (locked)
    throw new HttpProblem(
      429,
      'Code bloqué',
      'Trop de codes faux : réessayez dans une minute.',
      undefined,
      'PIN_LOCKED',
    );
  if (pin !== undefined && (await tillPinMatches(pin, stored))) {
    pinFailures.delete(key);
    return 'PIN';
  }
  pinFailures.set(key, [...failures.slice(-10), now]);
  throw new HttpProblem(
    403,
    'Code caissier incorrect',
    'Code caissier incorrect.',
    undefined,
    'PIN_WRONG',
  );
}
