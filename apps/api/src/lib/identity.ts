import { and, eq, isNull } from 'drizzle-orm';
import { passwordResetToken, userRole, type DbOrTx } from '@episoft/db';
import { identityChangeAllowed, isStaffAccount, type RoleCode } from '@episoft/shared';
import { escapeHtml, queueEmail } from './mail';
import { forbidden } from './problem';

// The sign-in identity of an account (e-mail, user name): the e-mail receives the « mot de passe
// oublié » link, so changing it can hand the account over (audit KV2, S02 and S04).

export async function rolesOf(db: DbOrTx, memberId: string): Promise<RoleCode[]> {
  const rows = await db
    .select({ code: userRole.roleCode })
    .from(userRole)
    .where(eq(userRole.memberId, memberId));
  return rows.map((r) => r.code as RoleCode);
}

/** Every reset link of the member still open becomes unusable. */
export async function revokeResetLinks(db: DbOrTx, memberId: string): Promise<void> {
  await db
    .update(passwordResetToken)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetToken.memberId, memberId), isNull(passwordResetToken.usedAt)));
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * Before changing the e-mail or the user name of a member, or before deactivating them: only an
 * administrator may do it on a staff account. Deactivating closes the sessions and blocks the
 * sign-in, so a volunteer could otherwise lock every administrator out. Returns what changes, for
 * `afterIdentityChange`.
 */
export async function checkIdentityChange(
  db: DbOrTx,
  actorRoles: readonly RoleCode[],
  target: { id: string; email: string | null; username: string | null; status?: string },
  next: { email?: string | null; username?: string | null; status?: string },
): Promise<{ emailChanged: boolean; usernameChanged: boolean; targetRoles: RoleCode[] }> {
  const emailChanged = next.email !== undefined && norm(next.email) !== norm(target.email);
  const usernameChanged =
    next.username !== undefined && norm(next.username) !== norm(target.username);
  const deactivated =
    next.status !== undefined &&
    next.status !== target.status &&
    (next.status === 'INACTIVE' || next.status === 'ARCHIVED');
  const targetRoles = await rolesOf(db, target.id);
  if (identityChangeAllowed(actorRoles, targetRoles))
    return { emailChanged, usernameChanged, targetRoles };
  if (emailChanged || usernameChanged)
    throw forbidden(
      'Seul un administrateur peut changer le courriel ou l’identifiant d’un compte de l’équipe (bénévole avec un rôle).',
    );
  if (deactivated)
    throw forbidden(
      'Seul un administrateur peut désactiver ou archiver un compte de l’équipe (bénévole avec un rôle).',
    );
  return { emailChanged, usernameChanged, targetRoles };
}

/**
 * After the change: the reset links already sent are revoked, and the previous address of a staff
 * account is told, so that a change made by someone else does not go unnoticed.
 */
export async function afterIdentityChange(
  db: DbOrTx,
  target: { id: string; email: string | null; firstName: string },
  change: { emailChanged: boolean; usernameChanged: boolean; targetRoles: RoleCode[] },
): Promise<void> {
  if (!change.emailChanged && !change.usernameChanged) return;
  await revokeResetLinks(db, target.id);
  if (!change.emailChanged || !target.email || !isStaffAccount(change.targetRoles)) return;
  const what = 'L’adresse de courriel de votre compte EpiSoft vient d’être modifiée.';
  const todo =
    'Si vous n’êtes pas à l’origine de ce changement, prévenez sans attendre un administrateur de l’association.';
  await queueEmail(db, {
    to: target.email,
    subject: 'Épicafé : l’adresse de votre compte a changé',
    text: `Bonjour ${target.firstName},\n\n${what}\n${todo}`,
    html: `<p>Bonjour ${escapeHtml(target.firstName)},</p><p>${what}</p><p>${todo}</p>`,
  });
}
