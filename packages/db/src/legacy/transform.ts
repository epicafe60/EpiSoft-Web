import {
  cleanText,
  isValidEmail,
  memberStatusFromLegacy,
  parseLegacyPerms,
  type MemberStatus,
  type RoleCode,
} from '@episoft/shared';

// Pure legacy → v2 transforms (spec §6.3). No I/O here, so they can be unit tested.

export interface Issue {
  entity: string;
  legacyId: string;
  field: string;
  value: string;
  problem: string;
  action: string;
}

/** Pascal booleans: -1 (or any non-zero) is true; null is false. */
export function legacyBool(v: number | string | null | undefined): boolean {
  return v != null && Number(v) !== 0;
}

export interface LegacyMemberRow {
  MBREID: number;
  MBRENOM: string | null;
  MBREPRENOM: string | null;
  MBREADR: string | null;
  MBRECPOST: number | null;
  MBRECITY: number | null;
  MBRETELEPH: string | null;
  MBREMAIL: string | null;
  MBREREF: number | null;
  MBRESTATUT: number | null;
  MBREPERMS: string | null;
  MBREVISIBLE: number | null;
  MBRENEWS: number | null;
  MBREUSERNAME: string | null;
  /** MBREQRCODE decoded as text. */
  qr: string | null;
}

export interface LegacyCommune {
  legacyId: number;
  postcode: string;
}

export interface MemberDraft {
  legacyMbreid: number;
  legacyHouseholdId: number | null;
  lastName: string;
  firstName: string;
  street: string | null;
  postcode: string | null;
  legacyCommuneId: number | null;
  phone: string | null;
  email: string | null;
  status: MemberStatus;
  publicVisible: boolean;
  newsletter: boolean;
  username: string | null;
  /** Raw token, hashed by the caller. Null when absent or not unique. */
  qrToken: string | null;
  roles: RoleCode[];
}

/** R-MBR-10: the pseudo-member 0 "Adhérent de passage" and household 0 are not migrated. */
export const PASSING_MEMBER_ID = 0;

/** R-MBR-05: QR tokens are at least 15 characters. */
export const QR_MIN_LENGTH = 15;

/** Counts each non-empty QR token; tokens used more than once are ambiguous. */
export function qrUsage(rows: readonly LegacyMemberRow[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const r of rows) {
    const t = r.qr?.trim();
    if (t) usage.set(t, (usage.get(t) ?? 0) + 1);
  }
  return usage;
}

const POSTCODE_RE = /^\d{5}$/;

export function transformMember(
  r: LegacyMemberRow,
  communes: ReadonlyMap<number, LegacyCommune>,
  qrCounts: ReadonlyMap<string, number>,
  householdIds: ReadonlySet<number>,
): { draft: MemberDraft; issues: Issue[] } {
  const issues: Issue[] = [];
  const id = String(r.MBREID);
  const issue = (field: string, value: unknown, problem: string, action: string) =>
    issues.push({
      entity: 'membre',
      legacyId: id,
      field,
      value: String(value ?? ''),
      problem,
      action,
    });

  // Commune and postcode: the commune's postcode wins when they disagree.
  let legacyCommuneId: number | null = null;
  let postcode: string | null = r.MBRECPOST ? String(r.MBRECPOST) : null;
  if (r.MBRECITY != null && r.MBRECITY > 0) {
    const c = communes.get(r.MBRECITY);
    if (c) {
      legacyCommuneId = c.legacyId;
      if (postcode !== c.postcode) {
        issue(
          'MBRECPOST',
          r.MBRECPOST,
          `différent du code postal de la commune (${c.postcode})`,
          'code postal de la commune repris',
        );
        postcode = c.postcode;
      }
    } else {
      issue('MBRECITY', r.MBRECITY, 'commune inexistante', 'commune laissée vide');
    }
  } else {
    issue('MBRECITY', r.MBRECITY, 'pas de commune', 'commune laissée vide');
  }
  if (postcode !== null && !POSTCODE_RE.test(postcode)) {
    issue('MBRECPOST', postcode, 'code postal invalide', 'code postal laissé vide');
    postcode = null;
  }

  let email = cleanText(r.MBREMAIL);
  if (email !== null && !isValidEmail(email)) {
    issue('MBREMAIL', email, 'courriel invalide', 'courriel laissé vide');
    email = null;
  }

  let status = memberStatusFromLegacy(r.MBRESTATUT);
  if (!status) {
    issue('MBRESTATUT', r.MBRESTATUT, 'statut inconnu', 'statut Actif');
    status = 'ACTIVE';
  }

  const perms = parseLegacyPerms(r.MBREPERMS);
  for (const u of perms.unknown) issue('MBREPERMS', u, 'droit inconnu', 'ignoré');

  let qrToken = r.qr?.trim() || null;
  if (qrToken) {
    const count = qrCounts.get(qrToken) ?? 0;
    if (count > 1) {
      issue(
        'MBREQRCODE',
        `(partagé par ${count} membres)`,
        'QR code non unique',
        'non repris : badge à régénérer',
      );
      qrToken = null;
    } else if (qrToken.length < QR_MIN_LENGTH) {
      issue(
        'MBREQRCODE',
        `(${qrToken.length} caractères)`,
        `QR code de moins de ${QR_MIN_LENGTH} caractères`,
        'repris ; à régénérer',
      );
    }
  }

  let legacyHouseholdId: number | null = r.MBREREF;
  if (legacyHouseholdId == null || !householdIds.has(legacyHouseholdId)) {
    issue('MBREREF', r.MBREREF, 'foyer inexistant', 'membre sans foyer');
    legacyHouseholdId = null;
  }

  const lastName = cleanText(r.MBRENOM) ?? '?';
  const firstName = cleanText(r.MBREPRENOM) ?? '?';
  if (lastName === '?' || firstName === '?')
    issue('MBRENOM', `${r.MBRENOM} ${r.MBREPRENOM}`, 'nom ou prénom vide', '« ? » saisi');

  return {
    draft: {
      legacyMbreid: r.MBREID,
      legacyHouseholdId,
      lastName,
      firstName,
      street: cleanText(r.MBREADR),
      postcode,
      legacyCommuneId,
      phone: cleanText(r.MBRETELEPH),
      email,
      status,
      publicVisible: legacyBool(r.MBREVISIBLE),
      newsletter: legacyBool(r.MBRENEWS),
      username: cleanText(r.MBREUSERNAME),
      qrToken,
      roles: perms.roles,
    },
    issues,
  };
}

/**
 * Roles after a repeated migration: roles that exist in the legacy app (indices 0–6)
 * follow the legacy data, which stays the reference until switch-over (§9.3);
 * v2-only roles (STATS, ADMIN) granted in the new app are kept.
 */
export const LEGACY_MANAGED_ROLES: readonly RoleCode[] = [
  'CAISSE',
  'COMMANDES_EN_LIGNE',
  'COMMANDES_GESTION',
  'ADHERENTS',
  'PRODUITS',
  'APPROS',
  'COMPTA',
];

export function mergeRoles(
  current: readonly RoleCode[],
  fromLegacy: readonly RoleCode[],
): RoleCode[] {
  const kept = current.filter((r) => !LEGACY_MANAGED_ROLES.includes(r));
  return [...new Set([...fromLegacy, ...kept])];
}
