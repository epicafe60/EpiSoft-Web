import { z } from 'zod';
import { patchOf } from './patch';

// Signalements: a bug or an idea reported from any screen by any signed-in person, handled by the
// administrators. Not to be mixed up with the « tickets » of the till (sales). Pure rules.

export const FEEDBACK_KINDS = ['BUG', 'EVOLUTION'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  BUG: 'Problème (bug)',
  EVOLUTION: 'Idée (évolution)',
};

export const FEEDBACK_STATUSES = [
  'NEW',
  'ACCEPTED',
  'IN_PROGRESS',
  'TO_TEST',
  'DONE',
  'REFUSED',
  'DUPLICATE',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  NEW: 'Nouveau',
  ACCEPTED: 'Accepté',
  IN_PROGRESS: 'En cours',
  TO_TEST: 'À tester',
  DONE: 'Terminé',
  REFUSED: 'Refusé',
  DUPLICATE: 'Doublon',
};
/** A closed signalement no longer waits for anybody. */
export const FEEDBACK_CLOSED: readonly FeedbackStatus[] = ['DONE', 'REFUSED', 'DUPLICATE'];
export const isFeedbackClosed = (s: FeedbackStatus) => FEEDBACK_CLOSED.includes(s);

export const FEEDBACK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];
export const FEEDBACK_PRIORITY_LABELS: Record<FeedbackPriority, string> = {
  LOW: 'Basse',
  NORMAL: 'Normale',
  HIGH: 'Haute',
};

/** The part of the application a signalement is about: the modules, and the screens outside them. */
export const FEEDBACK_MODULES = [
  { key: 'caisse', label: 'Caisse', prefix: '/caisse' },
  { key: 'membres', label: 'Membres', prefix: '/membres' },
  { key: 'catalogue', label: 'Produits', prefix: '/catalogue' },
  { key: 'appros', label: 'Approvisionnements', prefix: '/appros' },
  { key: 'precommandes', label: 'Précommandes', prefix: '/precommandes' },
  { key: 'compta', label: 'Comptabilité', prefix: '/compta' },
  { key: 'stats', label: 'Statistiques', prefix: '/stats' },
  { key: 'admin', label: 'Administration', prefix: '/admin' },
  { key: 'surveillance', label: 'Surveillance', prefix: '/surveillance' },
  { key: 'imports', label: 'Imports', prefix: '/imports' },
  { key: 'boutique', label: 'Boutique', prefix: '/boutique' },
  { key: 'foyer', label: 'Mon foyer', prefix: '/mon-foyer' },
  { key: 'connexion', label: 'Connexion et compte', prefix: '/connexion' },
  { key: 'autre', label: 'Autre ou général', prefix: '' },
] as const;
export type FeedbackModule = (typeof FEEDBACK_MODULES)[number]['key'];
const MODULE_KEYS = FEEDBACK_MODULES.map((m) => m.key) as [FeedbackModule, ...FeedbackModule[]];
export const feedbackModuleLabel = (key: string) =>
  FEEDBACK_MODULES.find((m) => m.key === key)?.label ?? key;

/** The module of the page the person is on, to pre-fill the form: `/membres/foyers/3` → `membres`. */
export function moduleOfPath(pathname: string): FeedbackModule {
  const path = pathname.split(/[?#]/)[0] ?? '';
  for (const m of FEEDBACK_MODULES)
    if (m.prefix && (path === m.prefix || path.startsWith(`${m.prefix}/`))) return m.key;
  return 'autre';
}

export const FEEDBACK_NUMBER_PREFIX = 'SIG';
/** SIG-0042: continuous numbering, like the other documents of the application. */
export const formatFeedbackNumber = (n: number) =>
  `${FEEDBACK_NUMBER_PREFIX}-${String(n).padStart(4, '0')}`;

/** What the application notes by itself about where the report was made (never typed values). */
export const feedbackContextSchema = z.object({
  page: z.string().trim().max(300).optional(),
  userAgent: z.string().trim().max(300).optional(),
  viewport: z.string().trim().max(20).optional(),
});
export type FeedbackContext = z.infer<typeof feedbackContextSchema>;

const feedbackFields = {
  kind: z.enum(FEEDBACK_KINDS),
  module: z.enum(MODULE_KEYS),
  /** The screen, as the person names it: pre-filled with the title of the page. */
  screen: z.string().trim().max(120).default(''),
  title: z.string().trim().min(5, 'Donnez un titre d’au moins 5 caractères.').max(120),
  description: z
    .string()
    .trim()
    .min(10, 'Décrivez la situation en quelques mots (10 caractères au moins).')
    .max(4000),
  steps: z.string().trim().max(3000).default(''),
  context: feedbackContextSchema.default({}),
};

export const feedbackCreateSchema = z.object(feedbackFields).superRefine((v, ctx) => {
  if (v.kind === 'BUG' && v.steps.length < 5)
    ctx.addIssue({
      code: 'custom',
      path: ['steps'],
      message: 'Pour un problème, indiquez les étapes pour le reproduire.',
    });
});
export type FeedbackCreateInput = z.infer<typeof feedbackCreateSchema>;

/** What an administrator changes. */
export const feedbackManageSchema = patchOf({
  status: z.enum(FEEDBACK_STATUSES),
  priority: z.enum(FEEDBACK_PRIORITIES),
}).refine((v) => v.status !== undefined || v.priority !== undefined, 'Rien à modifier.');
export type FeedbackManageInput = z.infer<typeof feedbackManageSchema>;

export const feedbackCommentSchema = z.object({
  body: z.string().trim().min(1, 'Écrivez un message.').max(2000),
});

export const feedbackQuerySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  kind: z.enum(FEEDBACK_KINDS).optional(),
  module: z.enum(MODULE_KEYS).optional(),
  /** `open` = not closed. */
  open: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export interface FeedbackRow {
  id: string;
  number: string;
  kind: FeedbackKind;
  module: string;
  screen: string;
  title: string;
  status: FeedbackStatus;
  priority: FeedbackPriority;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface FeedbackComment {
  id: string;
  authorId: string | null;
  authorName: string | null;
  /** True for a reply of the team (an administrator), false for the author's own message. */
  fromTeam: boolean;
  body: string;
  createdAt: string;
}

export interface FeedbackDetail extends FeedbackRow {
  description: string;
  steps: string;
  context: FeedbackContext;
  comments: FeedbackComment[];
}
