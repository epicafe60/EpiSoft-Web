import { z } from 'zod';

// Data retention (ADR 0017). What the application keeps, for how long, and the legal floors under
// which nothing may be purged. One list of « classes » drives the setting (`data.retention`), its
// validation, the purge engine of the API, the Administration screen and the processing register
// (`retentionRegister()`, read by the RGPD documents).

export type RetentionNature = 'LEGAL' | 'BUSINESS' | 'TECHNICAL';
export type RetentionUnit = 'days' | 'months';

/** The lowest value allowed for a class, and the sentence that says why. */
export interface RetentionFloor {
  /** In the unit of the class. */
  value: number;
  /** Shown when a lower value is refused. */
  rule: string;
  /** A legal obligation (as opposed to a technical safety). */
  legal: boolean;
}

export interface RetentionClass {
  id: string;
  label: string;
  nature: RetentionNature;
  unit: RetentionUnit;
  /** What is removed once the duration is over, in plain words. */
  scope: string;
  /** What the application keeps of it. */
  keeps: string;
  /** The tables concerned. */
  tables: string[];
  /** The duration proposed at installation (null: kept for ever). */
  defaultValue: number | null;
  floor: RetentionFloor | null;
  /** A shorter duration is allowed but not advised (a warning, never a refusal). */
  recommendedMin?: { value: number; advice: string };
}

const LAW_COMMERCE =
  'Code de commerce, art. L123-22 : les documents comptables et pièces justificatives se conservent 10 ans.';
const LAW_TICKETS =
  'Livre des procédures fiscales (art. L102 B et L169) : les tickets, ventes et clôtures de caisse se conservent 6 ans.';

const legalFloor = (value: number, rule: string): RetentionFloor => ({ value, rule, legal: true });
const safety = (value: number, rule: string): RetentionFloor => ({ value, rule, legal: false });

/**
 * The classes an administrator can configure (purgeable). Order = order on the screen.
 * Journals about legal data (accounting, tickets) carry the legal floor of the data itself: the
 * journal is the proof of how the figures came to be.
 */
export const RETENTION_CLASSES: readonly RetentionClass[] = [
  // --- Technical: freely configurable ---------------------------------------------------------
  {
    id: 'email_body',
    label: 'Contenu des courriels envoyés',
    nature: 'TECHNICAL',
    unit: 'days',
    scope: 'Le texte, le HTML et les pièces jointes des courriels envoyés (ou en échec).',
    keeps: 'La ligne du journal des courriels : destinataire, objet, date, état.',
    tables: ['email_outbox'],
    defaultValue: 90,
    floor: safety(7, 'Le courriel doit rester consultable le temps de constater qu’il est parti.'),
  },
  {
    id: 'email_rows',
    label: 'Journal des courriels (lignes)',
    nature: 'TECHNICAL',
    unit: 'months',
    scope:
      'Les lignes du journal des courriels déjà envoyés ou en échec (jamais celles en attente).',
    keeps: 'Rien : la ligne disparaît.',
    tables: ['email_outbox'],
    defaultValue: 24,
    floor: safety(
      3,
      'Le journal des courriels sert à comprendre un message non reçu : 3 mois au moins.',
    ),
  },
  {
    id: 'error_log',
    label: 'Erreurs du serveur',
    nature: 'TECHNICAL',
    unit: 'months',
    scope: 'Les erreurs inattendues dont la dernière occurrence est ancienne.',
    keeps: 'Rien.',
    tables: ['error_log'],
    defaultValue: 12,
    floor: safety(1, 'Une erreur doit rester un mois pour être analysée.'),
  },
  {
    id: 'sync_receipt',
    label: 'Accusés de synchronisation de la caisse',
    nature: 'TECHNICAL',
    unit: 'months',
    scope: 'Les reçus qui empêchent un ticket renvoyé par la caisse d’être enregistré deux fois.',
    keeps: 'Les tickets eux-mêmes (jamais touchés).',
    tables: ['sync_receipt'],
    defaultValue: 12,
    floor: safety(
      3,
      'Une caisse restée hors ligne peut renvoyer ses tickets des semaines plus tard : 3 mois au moins pour éviter un doublon.',
    ),
  },
  {
    id: 'sync_rejection',
    label: 'Tickets refusés à la synchronisation (classés)',
    nature: 'TECHNICAL',
    unit: 'months',
    scope: 'Les tickets refusés par le serveur et déjà classés par un responsable.',
    keeps: 'Rien. Les tickets non classés ne sont jamais supprimés.',
    tables: ['sync_rejection'],
    defaultValue: 12,
    floor: safety(1, 'Un refus classé reste un mois consultable.'),
  },
  {
    id: 'job_run',
    label: 'Passages des tâches automatiques',
    nature: 'TECHNICAL',
    unit: 'months',
    scope: 'Le marquage « tâche faite ce jour-là » (alertes, sauvegardes de soldes…).',
    keeps: 'Rien.',
    tables: ['job_run'],
    defaultValue: 3,
    floor: safety(1, 'Les tâches du jour se repèrent avec ce marquage : 1 mois au moins.'),
  },
  {
    id: 'integrity_run',
    label: 'Historique des contrôles de cohérence',
    nature: 'TECHNICAL',
    unit: 'months',
    scope: 'Les passages anciens des contrôles (le plus récent est toujours conservé).',
    keeps: 'Le dernier passage.',
    tables: ['integrity_run'],
    defaultValue: 12,
    floor: safety(1, 'La courbe des contrôles se lit sur 1 mois au moins.'),
  },
  {
    id: 'wallet_snapshot',
    label: 'Photographies quotidiennes des cagnottes',
    nature: 'TECHNICAL',
    unit: 'months',
    scope:
      'Les soldes de fin de journée servant à détecter une dérive (le plus récent de chaque foyer est conservé).',
    keeps:
      'La photographie la plus récente de chaque foyer. Les écritures de cagnotte ne sont jamais touchées.',
    tables: ['wallet_snapshot'],
    defaultValue: 24,
    floor: safety(
      3,
      'Le contrôle des cagnottes compare avec les jours précédents : 3 mois au moins.',
    ),
  },
  {
    id: 'backup_run',
    label: 'Comptes rendus des sauvegardes',
    nature: 'TECHNICAL',
    unit: 'months',
    scope:
      'Les rapports anciens des sauvegardes et des tests de restauration (le dernier de chaque type est conservé).',
    keeps: 'Le dernier rapport de chaque type.',
    tables: ['backup_run'],
    defaultValue: 24,
    floor: safety(3, 'Le suivi des sauvegardes se lit sur 3 mois au moins.'),
  },
  {
    id: 'till_pin_attempt',
    label: 'Essais de code caissier',
    nature: 'TECHNICAL',
    unit: 'days',
    scope: 'Les essais de code caissier (justes ou faux).',
    keeps: 'Rien.',
    tables: ['till_pin_attempt'],
    defaultValue: 30,
    floor: safety(
      2,
      'Le blocage après des essais faux et l’alerte se calculent sur 24 h : 2 jours au moins.',
    ),
  },
  {
    id: 'expired_sessions',
    label: 'Sessions de connexion et liens de mot de passe expirés',
    nature: 'TECHNICAL',
    unit: 'days',
    scope: 'Les sessions et les liens de mot de passe dont la date de fin est dépassée.',
    keeps: 'Rien.',
    tables: ['session', 'password_reset_token'],
    defaultValue: 30,
    floor: safety(
      1,
      'Une session expirée depuis moins d’un jour peut encore être expliquée à un utilisateur.',
    ),
  },
  // --- Business: configurable, with a recommended minimum ----------------------------------------
  {
    id: 'login_log',
    label: 'Journal des connexions',
    nature: 'BUSINESS',
    unit: 'months',
    scope: 'Les connexions réussies ou refusées (qui, quand, depuis quelle adresse).',
    keeps: 'Rien.',
    tables: ['login_log'],
    defaultValue: 12,
    floor: safety(1, 'Les connexions servent à repérer une intrusion : 1 mois au moins.'),
    recommendedMin: {
      value: 6,
      advice:
        'La CNIL recommande de garder les traces de connexion de 6 à 12 mois : en dessous de 6 mois, une intrusion découverte tard ne pourra plus être retracée.',
    },
  },
  {
    id: 'feedback',
    label: 'Signalements clos',
    nature: 'BUSINESS',
    unit: 'months',
    scope: 'Les signalements terminés, refusés ou en doublon, avec leurs messages.',
    keeps: 'Rien. Les signalements ouverts ne sont jamais supprimés.',
    tables: ['feedback_ticket', 'feedback_comment'],
    defaultValue: 24,
    floor: safety(1, 'Un signalement clos reste un mois consultable.'),
    recommendedMin: {
      value: 6,
      advice:
        'Les signalements clos servent à retrouver pourquoi un choix a été fait : gardez-les 6 mois au moins.',
    },
  },
  {
    id: 'price_history',
    label: 'Historique des prix',
    nature: 'BUSINESS',
    unit: 'months',
    scope: 'Les anciens prix d’un produit (le prix le plus récent est toujours conservé).',
    keeps: 'Le dernier prix de chaque produit. Les tickets gardent le prix de la vente.',
    tables: ['price_history'],
    defaultValue: 60,
    floor: safety(
      3,
      'L’historique des prix sert aux marges et aux propositions : 3 mois au moins.',
    ),
    recommendedMin: {
      value: 24,
      advice:
        'Les statistiques de marge et d’évolution des prix lisent cet historique : gardez 2 ans au moins.',
    },
  },
  {
    id: 'audit_security',
    label: 'Journal d’audit : sécurité et données personnelles',
    nature: 'BUSINESS',
    unit: 'months',
    scope:
      'Connexions, mots de passe, rôles, changement d’identité, anonymisations, exports, réglages, annulations, purges.',
    keeps: 'Rien.',
    tables: ['audit_log'],
    defaultValue: 60,
    floor: safety(
      12,
      'Les traces d’accès et de gestion des données personnelles se gardent 12 mois au moins (CNIL).',
    ),
    recommendedMin: {
      value: 24,
      advice:
        'Ces actions servent à prouver qui a fait quoi en cas de litige ou de demande d’un adhérent : 2 ans au moins.',
    },
  },
  {
    id: 'audit_other',
    label: 'Journal d’audit : autres actions',
    nature: 'BUSINESS',
    unit: 'months',
    scope:
      'Catalogue, fournisseurs, commandes, stock, adhérents, courriels, signalements, réglages courants.',
    keeps: 'Rien.',
    tables: ['audit_log'],
    defaultValue: 36,
    floor: safety(
      3,
      'Le journal d’audit sert à annuler une action et au contrôle AUD-01 : 3 mois au moins.',
    ),
    recommendedMin: {
      value: 12,
      advice: 'Gardez un an au moins pour pouvoir retrouver l’origine d’une erreur de gestion.',
    },
  },
  {
    id: 'data_change_other',
    label: 'Journal des modifications ligne à ligne : autres tables',
    nature: 'BUSINESS',
    unit: 'months',
    scope: 'Avant/après de chaque ligne modifiée (catalogue, adhérents, fournisseurs, réglages…).',
    keeps: 'Rien. Les données elles-mêmes ne sont pas touchées.',
    tables: ['data_change'],
    defaultValue: 24,
    floor: safety(3, 'Le détail des modifications sert à annuler une action : 3 mois au moins.'),
    recommendedMin: {
      value: 6,
      advice:
        'En dessous de 6 mois, une erreur découverte à la clôture ne pourra plus être annulée depuis le journal.',
    },
  },
  // --- Journals about legal data: the floor of the data itself --------------------------------
  {
    id: 'data_change_sales',
    label: 'Journal des modifications : tickets et caisse',
    nature: 'BUSINESS',
    unit: 'months',
    scope: 'Avant/après des lignes de tickets, règlements, sessions et comptages de caisse.',
    keeps: 'Rien. Les tickets et les clôtures eux-mêmes ne sont jamais touchés.',
    tables: ['data_change'],
    defaultValue: 72,
    floor: legalFloor(72, LAW_TICKETS),
  },
  {
    id: 'data_change_accounting',
    label: 'Journal des modifications : comptabilité, cagnotte, stock',
    nature: 'BUSINESS',
    unit: 'months',
    scope:
      'Avant/après des écritures, comptes, factures fournisseurs, rapprochements, écritures de cagnotte, paiements d’adhérents, mouvements de stock.',
    keeps: 'Rien. Les écritures elles-mêmes ne sont jamais touchées.',
    tables: ['data_change'],
    defaultValue: 120,
    floor: legalFloor(120, LAW_COMMERCE),
  },
  {
    id: 'audit_sales',
    label: 'Journal d’audit : tickets et caisse',
    nature: 'BUSINESS',
    unit: 'months',
    scope: 'Ouvertures et clôtures de caisse, tickets, annulations.',
    keeps: 'Rien.',
    tables: ['audit_log'],
    defaultValue: 72,
    floor: legalFloor(72, LAW_TICKETS),
  },
  {
    id: 'audit_accounting',
    label: 'Journal d’audit : comptabilité, cagnotte, factures',
    nature: 'BUSINESS',
    unit: 'months',
    scope: 'Écritures, validations, exercices, banque, factures fournisseurs, cagnotte, adhésions.',
    keeps: 'Rien.',
    tables: ['audit_log'],
    defaultValue: 120,
    floor: legalFloor(120, LAW_COMMERCE),
  },
] as const;

export type RetentionClassId = (typeof RETENTION_CLASSES)[number]['id'];
export const RETENTION_CLASS_IDS = RETENTION_CLASSES.map((c) => c.id);

export const retentionClass = (id: string): RetentionClass | undefined =>
  RETENTION_CLASSES.find((c) => c.id === id);

/** What can never be purged by this tool: the legal records themselves (listed, read only). */
export interface LegalRetention {
  id: string;
  label: string;
  tables: string[];
  months: number;
  rule: string;
}

export const LEGAL_RETENTIONS: readonly LegalRetention[] = [
  {
    id: 'accounting',
    label: 'Écritures comptables, journaux, plan comptable, exercices, banque et rapprochements',
    tables: [
      'entry',
      'entry_line',
      'journal',
      'account',
      'fiscal_year',
      'reconciliation',
      'bank_account',
      'bank_statement',
      'bank_line',
      'cash_deposit',
    ],
    months: 120,
    rule: LAW_COMMERCE,
  },
  {
    id: 'supplier_invoices',
    label: 'Factures fournisseurs et leurs documents',
    tables: ['supplier_invoice', 'invoice_receipt'],
    months: 120,
    rule: LAW_COMMERCE,
  },
  {
    id: 'sales',
    label: 'Tickets, lignes, règlements, sessions et clôtures de caisse',
    tables: [
      'sale',
      'sale_line',
      'sale_payment',
      'cash_session',
      'cash_session_alias',
      'cash_count',
    ],
    months: 72,
    rule: LAW_TICKETS,
  },
  {
    id: 'wallet_and_payments',
    label: 'Cagnotte, adhésions et paiements des adhérents',
    tables: ['wallet_entry', 'membership', 'member_payment'],
    months: 120,
    rule: LAW_COMMERCE,
  },
  {
    id: 'supplies',
    label: 'Commandes, réceptions, mouvements de stock et inventaires',
    tables: [
      'purchase_order',
      'purchase_order_line',
      'goods_receipt',
      'goods_receipt_line',
      'stock_movement',
      'inventory_session',
      'inventory_line',
    ],
    months: 120,
    rule: `${LAW_COMMERCE} (pièces justificatives de la comptabilité et de la valorisation du stock)`,
  },
] as const;

/** The tables whose changes are kept as long as the accounting (journal of changes). */
export const ACCOUNTING_CHANGE_TABLES: readonly string[] = [
  ...LEGAL_RETENTIONS.filter((l) => l.id !== 'sales').flatMap((l) => l.tables),
  'entry_template',
  'entry_template_line',
  'entry_template_category',
  'bank_rule',
];
/** The tables whose changes are kept as long as the tickets. */
export const SALES_CHANGE_TABLES: readonly string[] = LEGAL_RETENTIONS.find(
  (l) => l.id === 'sales',
)!.tables;

export type AuditGroup = 'ACCOUNTING' | 'SALES' | 'SECURITY' | 'OTHER';

const ACCOUNTING_PREFIXES = [
  'account.',
  'accounting.',
  'bank_',
  'deposit.',
  'entry.',
  'fiscal_year.',
  'journal.',
  'template.',
  'invoice.',
  'wallet.',
  'membership.',
  'receipt.',
  'inventory.',
  'stock.',
];
const SALES_PREFIXES = ['device.', 'session.', 'sale.'];
const SECURITY_PREFIXES = [
  'auth.',
  'password.',
  'impersonate.',
  'till.',
  'setting.',
  'audit.',
  'retention.',
  'export.',
  'backup.',
  'integrity.',
];
const SECURITY_ACTIONS = [
  'member.roles',
  'member.anonymize',
  'member.export',
  'member.export_all',
  'member.qr_regenerate',
  'member.till_pin',
  'member.till_pin_clear',
  'push.expired',
];

/** The retention group of an action of the audit journal. */
export function auditGroupOf(action: string): AuditGroup {
  if (SECURITY_ACTIONS.includes(action) || SECURITY_PREFIXES.some((p) => action.startsWith(p)))
    return 'SECURITY';
  if (ACCOUNTING_PREFIXES.some((p) => action.startsWith(p))) return 'ACCOUNTING';
  if (SALES_PREFIXES.some((p) => action.startsWith(p))) return 'SALES';
  return 'OTHER';
}

export const AUDIT_GROUP_CLASS: Record<AuditGroup, RetentionClassId> = {
  ACCOUNTING: 'audit_accounting',
  SALES: 'audit_sales',
  SECURITY: 'audit_security',
  OTHER: 'audit_other',
};

/** The retention class of a table of the journal of changes. */
export function changeClassOf(table: string): RetentionClassId {
  if (ACCOUNTING_CHANGE_TABLES.includes(table)) return 'data_change_accounting';
  if (SALES_CHANGE_TABLES.includes(table)) return 'data_change_sales';
  return 'data_change_other';
}

// --- Setting -------------------------------------------------------------------------------------

const durationShape = Object.fromEntries(
  RETENTION_CLASSES.map((c) => [
    c.id,
    z
      .number({ error: 'Nombre entier attendu.' })
      .int('Nombre entier attendu.')
      .min(1, 'Au moins 1 (ou « Toujours » pour ne jamais purger).')
      .max(c.unit === 'days' ? 36500 : 1200, 'Valeur trop grande.')
      .nullable()
      .default(c.defaultValue),
  ]),
) as Record<string, z.ZodDefault<z.ZodNullable<z.ZodNumber>>>;

/** Quoting message of a refused value. */
export function floorMessage(c: RetentionClass): string {
  const f = c.floor!;
  const unit = c.unit === 'days' ? 'jour(s)' : 'mois';
  return `${f.legal ? 'Obligation légale' : 'Minimum de sécurité'} : ${f.value} ${unit} au moins. ${f.rule}`;
}

export const retentionSchema = z
  .object({
    /** The nightly purge: off until the administrators turn it on. */
    nightly: z.boolean().default(false),
    /** Keep a compressed copy of what a purge removes, for the administrators to download. */
    archiveBeforePurge: z.boolean().default(true),
    /** Per class, in its unit; null: kept for ever. */
    durations: z.object(durationShape).default(() => defaultDurations()),
    /** Spec Q8: members left inactive are anonymised (RGPD). */
    anonymization: z
      .object({
        enabled: z.boolean().default(false),
        years: z.number().int().min(1, 'Au moins 1 an.').max(30, 'Valeur trop grande.').default(3),
      })
      .default({ enabled: false, years: 3 }),
    /** Thresholds of « À surveiller ». null: no alert. */
    alerts: z
      .object({
        dbSizeMb: z
          .number()
          .int()
          .min(50, 'Au moins 50 Mo.')
          .max(10_000_000)
          .nullable()
          .default(2048),
        diskFreePct: z
          .number()
          .int()
          .min(1, 'Entre 1 et 90.')
          .max(90, 'Entre 1 et 90.')
          .nullable()
          .default(10),
      })
      .default({ dbSizeMb: 2048, diskFreePct: 10 }),
  })
  .superRefine((v, ctx) => {
    for (const c of RETENTION_CLASSES) {
      const value = v.durations[c.id as keyof typeof v.durations] as number | null;
      if (value !== null && c.floor && value < c.floor.value) {
        ctx.addIssue({ code: 'custom', path: ['durations', c.id], message: floorMessage(c) });
      }
    }
  });

export type RetentionSettings = z.output<typeof retentionSchema>;

export function defaultDurations(): Record<string, number | null> {
  return Object.fromEntries(RETENTION_CLASSES.map((c) => [c.id, c.defaultValue]));
}

export const DEFAULT_RETENTION: RetentionSettings = {
  nightly: false,
  archiveBeforePurge: true,
  durations: defaultDurations() as RetentionSettings['durations'],
  anonymization: { enabled: false, years: 3 },
  alerts: { dbSizeMb: 2048, diskFreePct: 10 },
};

/** Warnings (never refusals): a duration under the recommended minimum of its class. */
export function retentionWarnings(v: RetentionSettings): { id: string; message: string }[] {
  const out: { id: string; message: string }[] = [];
  for (const c of RETENTION_CLASSES) {
    const value = v.durations[c.id as keyof typeof v.durations] as number | null;
    if (value !== null && c.recommendedMin && value < c.recommendedMin.value)
      out.push({ id: c.id, message: c.recommendedMin.advice });
  }
  return out;
}

/** The date before which what the class holds can be purged (null: nothing is purged). */
export function retentionCutoff(now: Date, value: number | null, unit: RetentionUnit): Date | null {
  if (value === null) return null;
  const d = new Date(now.getTime());
  if (unit === 'days') d.setUTCDate(d.getUTCDate() - value);
  else {
    // Month arithmetic that never overflows (31 March − 1 month = 28/29 February).
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - value);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d;
}

/** Members whose last activity is before this date are candidates for anonymisation (Q8). */
export function inactivityCutoff(now: Date, years: number): Date {
  return retentionCutoff(now, years * 12, 'months')!;
}

export interface RetentionRegisterLine {
  id: string;
  label: string;
  nature: RetentionNature;
  tables: string[];
  /** Human text: « 90 jours », « 6 ans (minimum légal) », « Illimitée ». */
  duration: string;
  months: number | null;
  legalBasis: string | null;
}

export function formatDuration(value: number | null, unit: RetentionUnit): string {
  if (value === null) return 'Illimitée';
  if (unit === 'days') return `${value} jour${value > 1 ? 's' : ''}`;
  if (value % 12 === 0) return `${value / 12} an${value / 12 > 1 ? 's' : ''}`;
  return `${value} mois`;
}

/**
 * The durations in force, for the processing register (RGPD): the legal records (fixed), then every
 * configurable class with its current value, then the anonymisation of inactive members.
 */
export function retentionRegister(
  settings: RetentionSettings = DEFAULT_RETENTION,
): RetentionRegisterLine[] {
  const lines: RetentionRegisterLine[] = LEGAL_RETENTIONS.map((l) => ({
    id: l.id,
    label: l.label,
    nature: 'LEGAL',
    tables: [...l.tables],
    duration: `${formatDuration(l.months, 'months')} (minimum légal, jamais purgé)`,
    months: l.months,
    legalBasis: l.rule,
  }));
  for (const c of RETENTION_CLASSES) {
    const value = settings.durations[c.id as keyof typeof settings.durations] as number | null;
    lines.push({
      id: c.id,
      label: c.label,
      nature: c.nature,
      tables: [...c.tables],
      duration: formatDuration(value, c.unit),
      months: value === null ? null : c.unit === 'days' ? Math.ceil(value / 30) : value,
      legalBasis: c.floor?.legal ? c.floor.rule : null,
    });
  }
  lines.push({
    id: 'inactive_members',
    label: 'Fiches des adhérents inactifs (anonymisation)',
    nature: 'BUSINESS',
    tables: ['member'],
    duration: settings.anonymization.enabled
      ? `${formatDuration(settings.anonymization.years * 12, 'months')} après la dernière activité, puis anonymisation`
      : 'Illimitée (anonymisation automatique désactivée)',
    months: settings.anonymization.enabled ? settings.anonymization.years * 12 : null,
    legalBasis: null,
  });
  return lines;
}
