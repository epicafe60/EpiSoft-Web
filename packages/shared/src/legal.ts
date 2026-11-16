import { z } from 'zod';

// RGPD: consents (what a member agreed to, when, on which text, how), the text of the two public
// pages (mentions légales, politique de confidentialité) and the register of processing. Pure data
// and rules; the API stores and serves them.

// --- Consents --------------------------------------------------------------------------------

export const CONSENT_PURPOSES = [
  'EMAIL_RECEIPTS',
  'NOTIFICATIONS',
  'NEWSLETTER',
  'IMAGE_RIGHTS',
  'DATA_PROCESSING',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** How a choice reached the application. */
export const CONSENT_CHANNELS = [
  'STAFF_FORM',
  'SELF_SERVICE',
  'PUSH',
  'IMPORT',
  'MIGRATION',
] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const CONSENT_CHANNEL_LABELS: Record<ConsentChannel, string> = {
  STAFF_FORM: 'Saisi par un bénévole sur la fiche',
  SELF_SERVICE: 'Choisi par le membre dans son espace',
  PUSH: 'Choisi par le membre sur son appareil',
  IMPORT: 'Import de fichier',
  MIGRATION: 'Repris de l’ancien logiciel',
};

export interface ConsentDefinition {
  label: string;
  /** The sentence shown to the person, whose version is recorded with the choice. */
  text: string;
  /** Bump it when the sentence changes in substance: the history keeps what was really shown. */
  version: string;
  /** Legal basis of the processing behind it. */
  basis: string;
  /** Can the member withdraw it by themselves in their area. */
  withdrawable: boolean;
}

export const CONSENTS: Record<ConsentPurpose, ConsentDefinition> = {
  EMAIL_RECEIPTS: {
    label: 'Tickets et reçus par courriel',
    text: 'J’accepte de recevoir par courriel mes tickets de caisse et les reçus de recharge de ma cagnotte.',
    version: '2026-11',
    basis: 'Consentement (art. 6.1.a du RGPD)',
    withdrawable: true,
  },
  NOTIFICATIONS: {
    label: 'Notifications sur l’appareil',
    text: 'J’accepte de recevoir des notifications sur cet appareil (commande prête, rappels).',
    version: '2026-11',
    basis: 'Consentement (art. 6.1.a du RGPD)',
    withdrawable: true,
  },
  NEWSLETTER: {
    label: 'Lettre d’information',
    text: 'J’accepte de recevoir la lettre d’information de l’association par courriel.',
    version: '2026-11',
    basis: 'Consentement (art. 6.1.a du RGPD)',
    withdrawable: true,
  },
  IMAGE_RIGHTS: {
    label: 'Droit à l’image',
    text: 'J’autorise l’association à utiliser mon image (photos, vidéos) pour sa communication.',
    version: '2026-11',
    basis: 'Consentement (art. 6.1.a du RGPD)',
    withdrawable: true,
  },
  DATA_PROCESSING: {
    label: 'Information sur le traitement des données',
    text: 'J’ai pris connaissance de la politique de confidentialité : mes données d’adhérent sont traitées pour gérer mon adhésion, mes achats et ma cagnotte.',
    version: '2026-11',
    basis: 'Information de la personne (art. 13 du RGPD) ; le traitement repose sur le contrat d’adhésion',
    withdrawable: false,
  },
};

export interface ConsentRecord {
  id: string;
  purpose: string;
  granted: boolean;
  textVersion: string;
  channel: string;
  at: string;
  recordedBy: string | null;
}

/** The current choice for each purpose: the latest record. Purposes never answered are absent. */
export function currentConsents(history: readonly ConsentRecord[]): Map<string, ConsentRecord> {
  const out = new Map<string, ConsentRecord>();
  for (const r of [...history].sort((a, b) => a.at.localeCompare(b.at)))
    out.set(r.purpose, r);
  return out;
}

export const consentChangeSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  granted: z.boolean(),
});

// --- Legal pages -----------------------------------------------------------------------------

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable();

/**
 * What an administrator writes for the two public pages. A field left empty uses the standard
 * wording below; the identity of the association (name, address, SIREN, RNA, contact) comes from
 * « Identité de l’association ».
 */
export const legalTextsSchema = z.object({
  /** Director of the publication (a natural person). */
  publicationDirector: optText(200),
  hostName: optText(200),
  hostAddress: optText(300),
  /** Where a person writes to exercise their rights. Falls back on the association's e-mail. */
  privacyContact: optText(200).refine(
    (s) => s === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    'Courriel invalide.',
  ),
  /** Data protection officer, when one is appointed (compulsory only in some cases). */
  dpoName: optText(200),
  dpoContact: optText(200),
  purposes: optText(4000),
  legalBasis: optText(4000),
  retention: optText(4000),
  recipients: optText(4000),
  rights: optText(4000),
  extra: optText(4000),
});
export type LegalTexts = z.infer<typeof legalTextsSchema>;

export const DEFAULT_LEGAL_TEXTS: LegalTexts = {
  publicationDirector: null,
  hostName: null,
  hostAddress: null,
  privacyContact: null,
  dpoName: null,
  dpoContact: null,
  purposes: null,
  legalBasis: null,
  retention: null,
  recipients: null,
  rights: null,
  extra: null,
};

export interface LegalIdentity {
  name: string;
  street: string | null;
  postcode: string | null;
  city: string | null;
  siren: string | null;
  rna: string | null;
  email: string | null;
  phone: string | null;
}

export interface LegalSection {
  title: string;
  paragraphs: string[];
}

export interface LegalPages {
  mentions: LegalSection[];
  privacy: LegalSection[];
  /** What is still missing for the pages to be complete (shown to administrators). */
  gaps: string[];
}

const address = (i: LegalIdentity) =>
  [i.street, [i.postcode, i.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

const lines = (s: string) =>
  s
    .split(/\n{1,}/)
    .map((x) => x.trim())
    .filter(Boolean);

/** What is compulsory on the pages and not written yet. */
export function legalGaps(i: LegalIdentity, t: LegalTexts): string[] {
  const gaps: string[] = [];
  if (!address(i)) gaps.push('l’adresse de l’association (Identité de l’association)');
  if (!i.rna && !i.siren) gaps.push('le numéro RNA ou SIREN de l’association');
  if (!t.publicationDirector) gaps.push('le directeur ou la directrice de la publication');
  if (!t.hostName || !t.hostAddress) gaps.push('le nom et l’adresse de l’hébergeur');
  if (!(t.privacyContact ?? i.email)) gaps.push('le courriel pour exercer ses droits');
  return gaps;
}

/** The two public pages, from the identity and the texts (standard wording where nothing is written). */
export function buildLegalPages(i: LegalIdentity, t: LegalTexts): LegalPages {
  const contact = t.privacyContact ?? i.email;
  const todo = '(à compléter par l’association)';
  const mentions: LegalSection[] = [
    {
      title: 'Éditeur du site',
      paragraphs: [
        `${i.name}, association${i.rna ? ` déclarée sous le numéro RNA ${i.rna}` : ''}${i.siren ? `, SIREN ${i.siren}` : ''}.`,
        `Adresse : ${address(i) || todo}.`,
        ...(i.phone ? [`Téléphone : ${i.phone}.`] : []),
        ...(i.email ? [`Courriel : ${i.email}.`] : []),
        `Directeur ou directrice de la publication : ${t.publicationDirector ?? todo}.`,
      ],
    },
    {
      title: 'Hébergement',
      paragraphs: [
        `${t.hostName ?? todo}${t.hostAddress ? `, ${t.hostAddress}` : ''}.`,
        'Les données sont hébergées dans l’Union européenne.',
      ],
    },
    {
      title: 'Propriété intellectuelle',
      paragraphs: [
        'Les textes, images et logos de ce site sont ceux de l’association ou de ses partenaires. Toute reproduction sans accord est interdite, sauf usage privé.',
      ],
    },
    {
      title: 'Données personnelles',
      paragraphs: ['Voir la politique de confidentialité, accessible depuis chaque page du site.'],
    },
    ...(t.extra ? [{ title: 'Informations complémentaires', paragraphs: lines(t.extra) }] : []),
  ];
  const privacy: LegalSection[] = [
    {
      title: 'Responsable du traitement',
      paragraphs: [
        `${i.name}${address(i) ? `, ${address(i)}` : ''}.`,
        `Contact pour toute question ou pour exercer vos droits : ${contact ?? todo}.`,
        t.dpoName
          ? `Délégué à la protection des données : ${t.dpoName}${t.dpoContact ? ` (${t.dpoContact})` : ''}.`
          : 'L’association n’a pas désigné de délégué à la protection des données (désignation non obligatoire pour elle).',
      ],
    },
    {
      title: 'Pourquoi nous utilisons vos données',
      paragraphs: t.purposes
        ? lines(t.purposes)
        : [
            'Gérer votre adhésion et celle de votre foyer.',
            'Tenir votre cagnotte et enregistrer vos achats (tickets de caisse).',
            'Prendre vos commandes en ligne et vous prévenir quand elles sont prêtes.',
            'Vous envoyer, si vous l’avez accepté, vos tickets, des notifications et la lettre d’information.',
            'Assurer la sécurité de l’application (connexions, journal des modifications) et respecter nos obligations comptables et de traçabilité des produits.',
          ],
    },
    {
      title: 'Base légale',
      paragraphs: t.legalBasis
        ? lines(t.legalBasis)
        : [
            'Votre adhésion : exécution du contrat d’adhésion (art. 6.1.b du RGPD).',
            'Conservation des tickets et des écritures : obligation légale comptable (art. 6.1.c).',
            'Sécurité de l’application : intérêt légitime de l’association (art. 6.1.f).',
            'Courriels de tickets, notifications, lettre d’information, droit à l’image : votre consentement (art. 6.1.a), que vous pouvez retirer à tout moment depuis votre espace ou auprès d’un bénévole.',
          ],
    },
    {
      title: 'Données concernées',
      paragraphs: [
        'Identité (nom, prénom), adresse, téléphone, courriel, identifiant, numéro d’adhérent, achats, mouvements de cagnotte, commandes et avis, journaux de connexion. La date de naissance n’est pas collectée. Aucune donnée de carte bancaire n’est conservée.',
      ],
    },
    {
      title: 'Qui y a accès',
      paragraphs: t.recipients
        ? lines(t.recipients)
        : [
            'Les bénévoles de l’association, selon leur rôle (la caisse n’affiche pas votre adresse, par exemple).',
            'Notre hébergeur technique, qui n’agit que sur nos instructions.',
            'Aucune donnée n’est vendue ni transmise à des tiers à des fins commerciales.',
          ],
    },
    {
      title: 'Combien de temps nous les gardons',
      paragraphs: t.retention
        ? lines(t.retention)
        : [
            'Données d’adhérent : pendant l’adhésion, puis 3 ans après la fin de la dernière adhésion ; elles sont ensuite anonymisées.',
            'Tickets de caisse et écritures comptables : 10 ans (obligation comptable).',
            'Journaux de connexion et de modification : durée limitée, précisée au registre des traitements.',
            'Preuves de consentement : tant que le consentement produit ses effets, puis le temps de la prescription.',
          ],
    },
    {
      title: 'Vos droits',
      paragraphs: t.rights
        ? lines(t.rights)
        : [
            'Vous pouvez demander l’accès à vos données (vous pouvez aussi les télécharger depuis votre espace), leur rectification, leur effacement, la limitation du traitement, vous opposer à un traitement, et obtenir vos données dans un format réutilisable.',
            `Pour cela, écrivez à ${contact ?? todo}. Nous répondons dans un délai d’un mois.`,
            'Si vous estimez, après nous avoir contactés, que vos droits ne sont pas respectés, vous pouvez saisir la CNIL (www.cnil.fr, 3 place de Fontenoy, 75334 Paris Cedex 07).',
          ],
    },
    {
      title: 'Cookies',
      paragraphs: [
        'L’application n’utilise qu’un témoin technique de connexion, indispensable à son fonctionnement ; il ne sert ni à la publicité ni au suivi.',
      ],
    },
  ];
  return { mentions, privacy, gaps: legalGaps(i, t) };
}

// --- Register of processing (art. 30 RGPD) ---------------------------------------------------

export interface ProcessingActivity {
  id: string;
  name: string;
  purpose: string;
  basis: string;
  /** Categories of data, as the people concerned would name them. */
  data: string[];
  people: string;
  recipients: string;
  /**
   * What the code applies today. It is a reference: the configurable retention policy (lot F) will
   * replace it here, this list only says what each processing keeps and why.
   */
  retention: string;
  /** Tables of the database that hold these data (checked against the schema by a test). */
  tables: string[];
}

export const PROCESSING_REGISTER: ProcessingActivity[] = [
  {
    id: 'members',
    name: 'Gestion des adhérents et des foyers',
    purpose: 'Gérer les adhésions, les foyers et la relation avec les adhérents.',
    basis: 'Contrat d’adhésion (art. 6.1.b)',
    data: ['Nom, prénom', 'Adresse, commune', 'Téléphone, courriel', 'Numéro d’adhérent', 'Statut', 'Cotisations'],
    people: 'Adhérents et membres de leur foyer',
    recipients: 'Bénévoles habilités (rôle ADHÉRENTS), hébergeur',
    retention: 'Durée de l’adhésion, puis 3 ans, puis anonymisation (spec. §5.7, Q8).',
    tables: ['member', 'household', 'membership', 'member_payment', 'commune'],
  },
  {
    id: 'sales',
    name: 'Ventes, cagnotte et tickets',
    purpose: 'Encaisser, tenir la cagnotte prépayée et conserver les justificatifs de vente.',
    basis: 'Contrat et obligation légale comptable (art. 6.1.b et 6.1.c)',
    data: ['Achats (produits, montants, moyen de paiement)', 'Mouvements de cagnotte', 'Caissier'],
    people: 'Adhérents, clients de passage (sans identité)',
    recipients: 'Bénévoles de la caisse et de la comptabilité, hébergeur',
    retention: 'Tickets et écritures : 10 ans (code de commerce, art. L123-22).',
    tables: ['sale', 'sale_line', 'sale_payment', 'wallet_entry', 'wallet_snapshot', 'wallet_low_notice', 'cash_session'],
  },
  {
    id: 'access',
    name: 'Accès à l’application et sécurité',
    purpose: 'Authentifier les personnes et détecter les usages anormaux.',
    basis: 'Intérêt légitime (art. 6.1.f) : sécurité du système',
    data: ['Identifiant, mot de passe haché', 'Adresse IP, date et résultat des connexions', 'Session'],
    people: 'Adhérents et bénévoles qui se connectent',
    recipients: 'Administrateurs, hébergeur',
    retention: 'Référence : sessions à leur expiration, journaux de connexion 12 mois (recommandation CNIL).',
    tables: ['session', 'login_log', 'password_reset_token', 'user_role', 'till_cashier_proof', 'till_pin_attempt'],
  },
  {
    id: 'messages',
    name: 'Courriels et notifications',
    purpose: 'Envoyer tickets, rappels, avis de commande, lettre d’information et notifications.',
    basis: 'Consentement (art. 6.1.a), rappels d’adhésion : intérêt légitime',
    data: ['Courriel', 'Contenu des messages', 'Abonnement de notification de l’appareil'],
    people: 'Adhérents',
    recipients: 'Prestataire d’envoi de courriels, hébergeur',
    retention: 'Référence : file des courriels 12 mois ; abonnement jusqu’au retrait.',
    tables: ['email_outbox', 'push_subscription'],
  },
  {
    id: 'consents',
    name: 'Preuves de consentement',
    purpose: 'Prouver ce que chaque adhérent a accepté ou retiré, et quand.',
    basis: 'Obligation de pouvoir démontrer le consentement (art. 7.1)',
    data: ['Finalité, choix, date, version du texte, mode de recueil'],
    people: 'Adhérents',
    recipients: 'Bénévoles habilités, hébergeur',
    retention: 'Tant que le consentement produit ses effets, puis le temps de la prescription.',
    tables: ['consent'],
  },
  {
    id: 'preorders',
    name: 'Commandes en ligne, avis et favoris',
    purpose: 'Préparer les commandes des adhérents et modérer leurs avis.',
    basis: 'Contrat (art. 6.1.b)',
    data: ['Commandes', 'Avis et notes', 'Produits favoris'],
    people: 'Adhérents',
    recipients: 'Bénévoles de la préparation et de la modération, hébergeur',
    retention: 'Commandes : comme les tickets (10 ans). Avis et favoris : jusqu’à la sortie de l’adhérent.',
    tables: ['preorder', 'product_review', 'product_favorite'],
  },
  {
    id: 'audit',
    name: 'Journal des modifications',
    purpose: 'Savoir qui a fait quoi, pouvoir annuler une erreur et prouver les opérations.',
    basis: 'Intérêt légitime (art. 6.1.f) et obligation de contrôle comptable',
    data: ['Auteur, date, adresse IP', 'Valeurs avant / après (données personnelles masquées à l’anonymisation)'],
    people: 'Adhérents et bénévoles',
    recipients: 'Administrateurs',
    retention: 'Référence : 10 ans pour ce qui touche à la comptabilité ; sinon à définir (politique de conservation à venir).',
    tables: ['audit_log', 'data_change'],
  },
  {
    id: 'traceability',
    name: 'Traçabilité des lots',
    purpose: 'Retrouver les clients d’un produit rappelé (règlement CE 178/2002, art. 18-19).',
    basis: 'Obligation légale (art. 6.1.c)',
    data: ['Lots reçus, tickets liés et adhérents identifiés'],
    people: 'Adhérents ayant acheté un produit alimentaire',
    recipients: 'Bénévoles des produits et des approvisionnements ; autorités sanitaires sur demande',
    retention: 'Référence : 5 ans après la date limite du produit, au moins.',
    tables: ['product_lot'],
  },
  {
    id: 'feedback',
    name: 'Signalements',
    purpose: 'Recueillir et traiter les problèmes et idées des utilisateurs.',
    basis: 'Intérêt légitime (art. 6.1.f)',
    data: ['Auteur, texte, pièces jointes'],
    people: 'Adhérents et bénévoles',
    recipients: 'Administrateurs',
    retention: 'Jusqu’au traitement du signalement, puis 1 an (référence).',
    tables: ['feedback_ticket', 'feedback_comment'],
  },
];
