// Roles and module access (spec §4.1 R-AUTH-05, annex B).

export const ROLE_CODES = [
  'CAISSE',
  'COMMANDES_EN_LIGNE',
  'COMMANDES_GESTION',
  'ADHERENTS',
  'PRODUITS',
  'APPROS',
  'COMPTA',
  'STATS',
  'ADMIN',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_LABELS: Record<RoleCode, string> = {
  CAISSE: 'Caisse',
  COMMANDES_EN_LIGNE: 'Commandes en ligne',
  COMMANDES_GESTION: 'Gestion des commandes',
  ADHERENTS: 'Adhérents',
  PRODUITS: 'Produits',
  APPROS: 'Approvisionnements',
  COMPTA: 'Comptabilité',
  STATS: 'Statistiques',
  ADMIN: 'Administration',
};

/** Legacy `membres.MBREPERMS` index → v2 role (annex B). */
const LEGACY_PERM_INDEX: Record<number, RoleCode> = {
  0: 'CAISSE',
  1: 'COMMANDES_EN_LIGNE',
  2: 'COMMANDES_GESTION',
  3: 'ADHERENTS',
  4: 'PRODUITS',
  5: 'APPROS',
  6: 'COMPTA',
};

export interface LegacyPermsResult {
  roles: RoleCode[];
  /** Tokens that are not a known index, reported in the migration report. */
  unknown: string[];
}

/** Parses `MBREPERMS` ("0|1|3"). Duplicates are removed; order follows ROLE_CODES. */
export function parseLegacyPerms(perms: string | null | undefined): LegacyPermsResult {
  const found = new Set<RoleCode>();
  const unknown: string[] = [];
  for (const raw of (perms ?? '').split('|')) {
    const token = raw.trim();
    if (token === '') continue;
    const role = /^\d+$/.test(token) ? LEGACY_PERM_INDEX[Number(token)] : undefined;
    if (role) found.add(role);
    else unknown.push(token);
  }
  return { roles: ROLE_CODES.filter((r) => found.has(r)), unknown };
}

/** ADMIN opens everything: the administrator has every module without being given each role. */
export function hasAnyRole(userRoles: readonly RoleCode[], required: readonly RoleCode[]): boolean {
  if (required.length === 0) return true;
  if (userRoles.includes('ADMIN')) return true;
  return required.some((r) => userRoles.includes(r));
}

/** Application modules and the roles that open them. Shared so the menu and the API guards agree. */
export const MODULES = [
  { key: 'caisse', label: 'Caisse', path: '/caisse', roles: ['CAISSE'] },
  { key: 'membres', label: 'Membres', path: '/membres', roles: ['ADHERENTS'] },
  { key: 'catalogue', label: 'Catalogue', path: '/catalogue', roles: ['PRODUITS'] },
  { key: 'appros', label: 'Approvisionnements', path: '/appros', roles: ['APPROS'] },
  {
    key: 'precommandes',
    label: 'Précommandes',
    path: '/precommandes',
    roles: ['COMMANDES_EN_LIGNE', 'COMMANDES_GESTION'],
  },
  { key: 'compta', label: 'Comptabilité', path: '/compta', roles: ['COMPTA'] },
  { key: 'stats', label: 'Statistiques', path: '/stats', roles: ['STATS'] },
  { key: 'admin', label: 'Administration', path: '/admin', roles: ['ADMIN'] },
] as const satisfies readonly {
  key: string;
  label: string;
  path: string;
  roles: readonly RoleCode[];
}[];

export type ModuleKey = (typeof MODULES)[number]['key'];

export function visibleModules(userRoles: readonly RoleCode[]) {
  return MODULES.filter((m) => hasAnyRole(userRoles, m.roles));
}
