import { z } from 'zod';
import { DEFAULT_BRANDING } from './branding';

const DEFAULT_IDENTITY_NAME = 'Épicafé de Montjavoult';

// E-mail templates: what each message says, with variables (`{{prenom}}`) filled in when it is sent.
// The wording below is the default; the administrators change it in the application and can put it
// back. No logic, no loops, no code: a variable is replaced by a value, and that is all, so that
// nobody can make a template do more than say something. Pure rules.

export type VariableKind =
  /** A text: escaped in the HTML, written as is in the text version. */
  | 'text'
  /** A fragment of HTML built by the application (a table of lines): never typed by a person. */
  | 'html'
  /** A web address built by the application: only http(s) is ever written. */
  | 'url';

export interface TemplateVariable {
  name: string;
  label: string;
  /** What the preview shows. */
  sample: string;
  kind: VariableKind;
  /** The template cannot be saved without it (a reset link without its link is useless). */
  required?: boolean;
}

export type TemplateAudience = 'MEMBER' | 'STAFF';

export interface TemplateDef {
  key: string;
  label: string;
  audience: TemplateAudience;
  /** When this e-mail is sent, for the person who edits it. */
  description: string;
  subject: string;
  /** HTML of the body (the header and the footer come from the common layout). */
  body: string;
  variables: TemplateVariable[];
}

const text = (name: string, label: string, sample: string): TemplateVariable => ({
  name,
  label,
  sample,
  kind: 'text',
});
const html = (name: string, label: string, sample: string): TemplateVariable => ({
  name,
  label,
  sample,
  kind: 'html',
});

const FIRST_NAME = text('prenom', 'Prénom', 'Marie');

/** Available in every template: what the association has set as its name (Administration › Paramètres). */
export const APP_VARIABLES: TemplateVariable[] = [
  text('association', 'Nom de l’association', DEFAULT_IDENTITY_NAME),
  text('association_court', 'Nom court de l’association', DEFAULT_BRANDING.shortName),
  text('application', 'Nom du logiciel', DEFAULT_BRANDING.appName),
];

/** The values of the variables every template has. */
export const appValues = (b: { shortName: string; appName: string }, name: string): Values => ({
  association: name,
  association_court: b.shortName,
  application: b.appName,
});

const SAMPLE_TABLE =
  '<table style="border-collapse:collapse;width:100%;font-size:14px"><tbody>' +
  '<tr><td style="padding:4px 6px;border-bottom:1px solid #e3e8e4">Lentilles vertes</td>' +
  '<td style="padding:4px 6px;border-bottom:1px solid #e3e8e4;text-align:right">2</td>' +
  '<td style="padding:4px 6px;border-bottom:1px solid #e3e8e4;text-align:right">5,00 €</td></tr>' +
  '<tr><td style="padding:4px 6px;border-bottom:1px solid #e3e8e4">Miel de fleurs</td>' +
  '<td style="padding:4px 6px;border-bottom:1px solid #e3e8e4;text-align:right">1</td>' +
  '<td style="padding:4px 6px;border-bottom:1px solid #e3e8e4;text-align:right">6,90 €</td></tr>' +
  '</tbody></table>';
const SAMPLE_LIST =
  '<ul><li>Premier point à regarder</li><li>Deuxième point à regarder</li><li>Troisième point</li></ul>';

export const EMAIL_TEMPLATES = [
  // --- Members ---------------------------------------------------------------------------------
  {
    key: 'sale_receipt',
    label: 'Ticket de caisse',
    audience: 'MEMBER',
    description:
      'Envoyé à l’adhérent après un achat en caisse (sauf s’il a refusé les tickets par courriel).',
    subject: '{{association_court}} : ticket {{numero}}',
    body:
      '<h2>Ticket {{numero}}</h2>' +
      '<p>Bonjour {{prenom}},<br>voici votre ticket du {{date}}.</p>' +
      '{{cagnotte_avant}}{{lignes}}' +
      '<p style="font-size:16px"><strong>Total : {{total}}</strong></p><p>{{paiements}}</p>' +
      '{{cagnotte_apres}}',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      text('numero', 'Numéro du ticket', 'T-2026-000123'),
      text('date', 'Date et heure', '14/11/2026 10:30'),
      text('total', 'Total', '16,90 €'),
      html('lignes', 'Tableau des articles', SAMPLE_TABLE),
      html('paiements', 'Moyens de paiement', 'Espèces : 10,00 €<br>Cagnotte : 6,90 €'),
      html(
        'cagnotte_avant',
        'Solde de la cagnotte avant (vide sans foyer)',
        '<p>Solde de votre cagnotte avant : 20,00 €</p>',
      ),
      html(
        'cagnotte_apres',
        'Solde de la cagnotte après (vide sans foyer)',
        '<p><strong>Solde de votre cagnotte après : 13,10 €</strong></p>',
      ),
    ],
  },
  {
    key: 'topup_receipt',
    label: 'Reçu de versement sur la cagnotte',
    audience: 'MEMBER',
    description: 'Envoyé au foyer quand un versement est enregistré (caisse ou back-office).',
    subject: '{{association_court}} : reçu de versement sur votre cagnotte',
    body:
      '<h2>Reçu de versement</h2>' +
      '<p>Bonjour {{prenom}},<br>nous avons bien reçu votre versement du {{date}}.</p>' +
      '<p>Ancien solde : {{ancien_solde}}<br>Versement : {{montant}} ({{mode}})<br>Nouveau solde : {{nouveau_solde}}</p>',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      text('date', 'Date et heure', '14/11/2026 10:30'),
      text('ancien_solde', 'Ancien solde', '5,00 €'),
      text('montant', 'Montant versé', '20,00 €'),
      text('mode', 'Moyen de paiement', 'Espèces'),
      text('nouveau_solde', 'Nouveau solde', '25,00 €'),
    ],
  },
  {
    key: 'password_link',
    label: 'Mot de passe : lien pour le définir',
    audience: 'MEMBER',
    description:
      'Envoyé pour choisir ou réinitialiser son mot de passe (mot de passe oublié, invitation).',
    subject: '{{association_court}} : définir votre mot de passe',
    body:
      '<p>Bonjour {{prenom}},</p>' +
      '<p>Pour définir votre mot de passe {{application}}, ouvrez ce lien (valable 1&nbsp;heure)&nbsp;:<br>' +
      '<a href="{{lien}}">{{lien}}</a></p>' +
      '<p>Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.</p>',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      {
        name: 'lien',
        label: 'Lien (indispensable)',
        sample: 'https://exemple.org/mot-de-passe?jeton=abc',
        kind: 'url',
        required: true,
      },
    ],
  },
  {
    key: 'identity_changed',
    label: 'Adresse du compte modifiée',
    audience: 'MEMBER',
    description:
      'Envoyé à l’ancienne adresse d’un compte de l’équipe dont le courriel vient de changer.',
    subject: '{{association_court}} : l’adresse de votre compte a changé',
    body:
      '<p>Bonjour {{prenom}},</p>' +
      '<p>L’adresse de courriel de votre compte {{application}} vient d’être modifiée.</p>' +
      '<p>Si vous n’êtes pas à l’origine de ce changement, prévenez sans attendre un administrateur de l’association.</p>',
    variables: [...APP_VARIABLES, FIRST_NAME],
  },
  {
    key: 'membership_reminder',
    label: 'Rappel d’adhésion',
    audience: 'MEMBER',
    description: 'Envoyé au foyer quelques jours avant la fin de son adhésion.',
    subject: '{{association_court}} : votre adhésion arrive à échéance',
    body:
      '<p>Bonjour {{prenom}},</p>' +
      '<p>L’adhésion de votre foyer à l’{{association_court}} se termine le <strong>{{date_fin}}</strong>. Vous pouvez la renouveler à la caisse lors de votre prochain passage.</p>' +
      '<p>Merci de votre soutien&nbsp;!</p>',
    variables: [...APP_VARIABLES, FIRST_NAME, text('date_fin', 'Date de fin', '31/12/2026')],
  },
  {
    key: 'wallet_low',
    label: 'Cagnotte basse',
    audience: 'MEMBER',
    description:
      'Envoyé au foyer dont la cagnotte passe sous le seuil réglé dans l’administration.',
    subject: '{{association_court}} : votre cagnotte est basse',
    body: '<p>Bonjour {{prenom}},</p><p>{{message}}</p><p>Merci&nbsp;!</p>',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      text(
        'message',
        'Phrase sur le solde',
        'Votre cagnotte n’est plus que de 3,20 €. Pensez à la recharger lors de votre prochain passage.',
      ),
    ],
  },
  {
    key: 'wallet_history',
    label: 'Historique de la cagnotte',
    audience: 'MEMBER',
    description: 'Envoyé au foyer depuis sa fiche (« envoyer l’historique »).',
    subject: '{{association_court}} : historique de votre cagnotte (solde {{solde}})',
    body:
      '<p>Bonjour {{prenom}},</p>' +
      '<p>Solde actuel de la cagnotte de votre foyer : <strong>{{solde}}</strong>.</p>{{historique}}',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      text('solde', 'Solde actuel', '13,10 €'),
      html('historique', 'Tableau des opérations', SAMPLE_TABLE),
    ],
  },
  {
    key: 'preorder_ready',
    label: 'Commande prête',
    audience: 'MEMBER',
    description: 'Envoyé au client quand sa précommande passe à « prête ».',
    subject: '{{association_court}} : votre commande {{numero}} est prête',
    body:
      '<p>Bonjour {{prenom}},</p>' +
      '<p>Votre commande <strong>{{numero}}</strong> est prête. Vous pouvez la retirer à l’{{association_court}} (retrait prévu le {{date_retrait}}) et la régler à la caisse.</p>' +
      '<p>À bientôt&nbsp;!</p>',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      text('numero', 'Numéro de la commande', 'P-2026-0042'),
      text('date_retrait', 'Date de retrait', '20/11/2026'),
    ],
  },
  // --- Staff -----------------------------------------------------------------------------------
  {
    key: 'closing_report',
    label: 'Compte rendu de clôture de caisse',
    audience: 'STAFF',
    description:
      'Envoyé au trésorier (adresse réglée dans l’administration) à chaque clôture, avec le PDF.',
    subject: '{{association_court}} : clôture de caisse du {{date_cloture}}',
    body: '<h2>Clôture de caisse</h2>{{tableau}}',
    variables: [
      ...APP_VARIABLES,
      text('date_cloture', 'Date de la clôture', '14/11/2026 18:30'),
      html('tableau', 'Tableau de la clôture', SAMPLE_TABLE),
    ],
  },
  {
    key: 'alert_ticket_rejected',
    label: 'Alerte : ticket de caisse refusé',
    audience: 'STAFF',
    description:
      'Envoyé aux responsables quand le serveur refuse un ticket envoyé par une caisse (au plus une fois par heure).',
    subject: '{{association_court}} : un ticket de caisse a été refusé',
    body:
      '<p>Un poste de caisse a envoyé une opération que le serveur a refusée.</p>' +
      '<p>Motif : {{motif}}</p>' +
      '<p>Ouvrez Surveillance › Tickets à vérifier pour la voir et la faire ressaisir.</p>',
    variables: [
      ...APP_VARIABLES,
      text('motif', 'Motif du refus', 'Total du ticket incohérent avec ses lignes.'),
    ],
  },
  {
    key: 'alert_server_error',
    label: 'Alerte : erreur inattendue du serveur',
    audience: 'STAFF',
    description:
      'Envoyé aux administrateurs en cas d’erreur inattendue (au plus une fois par heure pour la même erreur).',
    subject: '{{association_court}} : une erreur inattendue est survenue',
    body:
      '<ul><li>Page : {{page}}</li><li>Référence donnée à l’utilisateur : {{reference}}</li>' +
      '<li>Message : {{message}}</li><li>Nombre de fois (même erreur) : {{nombre}}</li></ul>' +
      '<p>Détails dans Surveillance › Erreurs du serveur.</p>',
    variables: [
      ...APP_VARIABLES,
      text('page', 'Page', 'POST /api/v1/products'),
      text('reference', 'Référence', '3FA9C2'),
      text('message', 'Message', 'violates foreign key constraint'),
      text('nombre', 'Nombre de fois', '3'),
    ],
  },
  {
    key: 'alert_pin_guessing',
    label: 'Alerte : codes caissier faux répétés',
    audience: 'STAFF',
    description:
      'Envoyé aux administrateurs quand trop de codes faux sont essayés pour un caissier.',
    subject: '{{association_court}} : codes caissier faux répétés ({{caissier}})',
    body:
      '<p>{{nombre}} codes faux en 15 minutes pour le caissier {{caissier}}.</p>' +
      '<p>Quelqu’un essaie peut-être de deviner son code. Le code est bloqué quelques minutes.</p>' +
      '<p>Détails dans Administration › Connexions.</p>',
    variables: [
      ...APP_VARIABLES,
      text('caissier', 'Caissier', 'Carl CAISSE'),
      text('nombre', 'Nombre de codes faux', '20'),
    ],
  },
  {
    key: 'alert_batches_due',
    label: 'Alerte : lots proches de leur date limite',
    audience: 'STAFF',
    description:
      'Envoyé chaque jour à l’équipe approvisionnements quand des lots sont périmés ou proches de leur date.',
    subject: '{{association_court}} : {{nombre}} lot(s) à surveiller (dates limites)',
    body: '<p>Lots périmés ou proches de leur date limite :</p>{{liste}}',
    variables: [
      ...APP_VARIABLES,
      text('nombre', 'Nombre de lots', '3'),
      html('liste', 'Liste des lots', SAMPLE_LIST),
    ],
  },
  {
    key: 'alert_integrity',
    label: 'Alerte : contrôles d’intégrité en échec',
    audience: 'STAFF',
    description:
      'Envoyé chaque jour aux administrateurs et à la comptabilité quand un contrôle de cohérence échoue.',
    subject: '{{association_court}} : {{nombre}} contrôle(s) d’intégrité en échec',
    body: '<p>Contrôles de cohérence en échec :</p>{{liste}}',
    variables: [
      ...APP_VARIABLES,
      text('nombre', 'Nombre de contrôles', '2'),
      html('liste', 'Liste des contrôles', SAMPLE_LIST),
    ],
  },
  {
    key: 'daily_digest',
    label: 'Résumé quotidien : points à surveiller',
    audience: 'STAFF',
    description:
      'Envoyé chaque matin aux administrateurs et à la comptabilité, s’il y a quelque chose à regarder.',
    subject: '{{association_court}} : points à surveiller',
    body: '<p>Ce qui mérite un coup d’œil aujourd’hui :</p>{{liste}}',
    variables: [...APP_VARIABLES, html('liste', 'Liste des points', SAMPLE_LIST)],
  },
  {
    key: 'alert_invoices_due',
    label: 'Alerte : factures fournisseur à régler',
    audience: 'STAFF',
    description:
      'Envoyé à la trésorerie quand des factures arrivent à échéance dans moins de 3 jours.',
    subject: '{{association_court}} : {{nombre}} facture(s) fournisseur à régler sous 3 jours',
    body: '<p>Factures à régler :</p>{{liste}}',
    variables: [
      ...APP_VARIABLES,
      text('nombre', 'Nombre de factures', '2'),
      html('liste', 'Liste des factures', SAMPLE_LIST),
    ],
  },
  {
    key: 'feedback_new',
    label: 'Signalement : nouveau signalement',
    audience: 'STAFF',
    description: 'Envoyé aux administrateurs quand quelqu’un signale un problème ou une idée.',
    subject: '{{association_court}} : nouveau signalement {{numero}}',
    body:
      '<p>{{type}} — {{module}}</p><p><strong>{{titre}}</strong></p>' +
      '<p>Signalé par {{auteur}}.</p><p>À traiter dans Signalements › Gestion.</p>',
    variables: [
      ...APP_VARIABLES,
      text('numero', 'Numéro', 'SIG-0012'),
      text('type', 'Type', 'Problème (bug)'),
      text('module', 'Module', 'Produits'),
      text('titre', 'Titre', 'Le bouton Enregistrer ne répond pas'),
      text('auteur', 'Auteur', 'Marie DUPONT'),
    ],
  },
  {
    key: 'feedback_reply',
    label: 'Signalement : réponse de l’équipe',
    audience: 'MEMBER',
    description: 'Envoyé à l’auteur d’un signalement quand l’équipe lui répond.',
    subject: '{{association_court}} : L’équipe a répondu à votre signalement ({{numero}})',
    body:
      '<p>Bonjour {{prenom}},</p><p>L’équipe a répondu à votre signalement.</p>' +
      '<p><strong>{{numero}} — {{titre}}</strong></p><p>{{message}}</p>' +
      '<p>Vous retrouvez votre signalement dans {{application}}, menu « Signalements ».</p>',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      text('numero', 'Numéro', 'SIG-0012'),
      text('titre', 'Titre', 'Le bouton Enregistrer ne répond pas'),
      text('message', 'Message de l’équipe', 'Corrigé, merci de vérifier.'),
    ],
  },
  {
    key: 'feedback_status',
    label: 'Signalement : changement d’état',
    audience: 'MEMBER',
    description: 'Envoyé à l’auteur d’un signalement quand son état change.',
    subject: '{{association_court}} : Votre signalement est passé à « {{etat}} » ({{numero}})',
    body:
      '<p>Bonjour {{prenom}},</p><p>Votre signalement est passé à « {{etat}} ».</p>' +
      '<p><strong>{{numero}} — {{titre}}</strong></p>' +
      '<p>Vous retrouvez votre signalement dans {{application}}, menu « Signalements ».</p>',
    variables: [
      ...APP_VARIABLES,
      FIRST_NAME,
      text('numero', 'Numéro', 'SIG-0012'),
      text('titre', 'Titre', 'Le bouton Enregistrer ne répond pas'),
      text('etat', 'Nouvel état', 'Terminé'),
    ],
  },
  // --- Suppliers -------------------------------------------------------------------------------
  {
    key: 'purchase_order',
    label: 'Commande fournisseur',
    audience: 'STAFF',
    description:
      'Texte proposé quand on envoie une commande à un fournisseur (le PDF est joint). Il reste modifiable à chaque envoi, avant de partir.',
    subject: 'Commande {{numero}} d’{{association}}',
    body:
      '<p>Bonjour,</p><p>Veuillez trouver ci-joint notre commande {{numero}} du {{date}}.</p>' +
      '<p>Bien cordialement !<br>L’équipe {{association}}</p>',
    variables: [
      ...APP_VARIABLES,
      text('numero', 'Numéro de la commande', 'CMD-2026-0012'),
      text('date', 'Date et heure', '14/11/2026 10:30'),
    ],
  },
] as const satisfies readonly TemplateDef[];

export type EmailTemplateKey = (typeof EMAIL_TEMPLATES)[number]['key'];
export const EMAIL_TEMPLATE_KEYS = EMAIL_TEMPLATES.map((t) => t.key) as [
  EmailTemplateKey,
  ...EmailTemplateKey[],
];

export function templateDef(key: string): TemplateDef | undefined {
  return (EMAIL_TEMPLATES as readonly TemplateDef[]).find((t) => t.key === key);
}
export const isTemplateKey = (key: string): key is EmailTemplateKey => !!templateDef(key);

// --- Variables ----------------------------------------------------------------------------------

const TOKEN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** The names of the variables a text uses, in order, once each. */
export function usedVariables(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(TOKEN)) names.add(m[1]!);
  return [...names];
}

export const escapeHtmlText = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&laquo;': '«',
  '&raquo;': '»',
};

/** The text of an HTML fragment, for the plain-text version of an e-mail. */
export function htmlToText(source: string): string {
  const withBreaks = source
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, label: string) => {
        const plainLabel = label.replace(/<[^>]*>/g, '').trim();
        return !plainLabel || plainLabel === href ? href : `${plainLabel} (${href})`;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]*>/g, '');
  return withBreaks
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|laquo|raquo);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}(?=\S)/g, '  ')
    .trim();
}

const isWebAddress = (s: string) => /^https?:\/\/[^\s"'<>]+$/i.test(s);

export type Values = Record<string, string | undefined>;

/** The HTML of a template: texts are escaped, fragments of the application are written as they are. */
export function fillHtml(
  source: string,
  values: Values,
  vars: readonly TemplateVariable[],
): string {
  return source.replace(TOKEN, (_m, name: string) => {
    const def = vars.find((v) => v.name === name);
    const value = values[name] ?? '';
    if (!def) return '';
    if (def.kind === 'html') return value;
    if (def.kind === 'url') return isWebAddress(value) ? escapeHtmlText(value) : '';
    return escapeHtmlText(value);
  });
}

/** A text version: the subject, and the plain-text alternative of the body. */
export function fillText(
  source: string,
  values: Values,
  vars: readonly TemplateVariable[],
): string {
  return source.replace(TOKEN, (_m, name: string) => {
    const def = vars.find((v) => v.name === name);
    const value = values[name] ?? '';
    if (!def) return '';
    if (def.kind === 'html') return htmlToText(value);
    if (def.kind === 'url') return isWebAddress(value) ? value : '';
    return value;
  });
}

/** A subject is one line, whatever a value holds. */
export const oneLine = (s: string) =>
  s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

// --- What an administrator may save -----------------------------------------------------------

export const EMAIL_LIMITS = {
  subject: 200,
  body: 40_000,
  footer: 8_000,
  imageBytes: 500 * 1024,
} as const;

export const emailTemplateSaveSchema = z.object({
  subject: z.string().trim().min(1, 'L’objet est obligatoire.').max(EMAIL_LIMITS.subject),
  body: z.string().trim().min(1, 'Le message est vide.').max(EMAIL_LIMITS.body),
});
export type EmailTemplateSave = z.infer<typeof emailTemplateSaveSchema>;

/**
 * A variable inside a tag (`href="{{x}}"`): in a link only a web address built by the application may
 * go (a typed text such as `javascript:...` would become the link); elsewhere in a tag only a text,
 * never a fragment of HTML, which would break out of the attribute.
 */
function attributeProblems(def: TemplateDef, body: string): string[] {
  const problems: string[] = [];
  for (const tag of body.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\b([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
      const name = attr[1]!.toLowerCase();
      for (const used of usedVariables(attr[3] ?? attr[4] ?? '')) {
        const v = def.variables.find((x) => x.name === used);
        if (!v) continue;
        const ok = name === 'href' ? v.kind === 'url' : v.kind === 'text';
        if (!ok)
          problems.push(
            name === 'href'
              ? `{{${used}}} ne peut pas être dans un lien : seule la variable « lien » y est permise.`
              : `{{${used}}} ne peut pas être dans un attribut (${name}) : placez-la dans le texte du message.`,
          );
      }
    }
  }
  return [...new Set(problems)];
}

/** What is wrong with a template, in words: unknown variables, a missing indispensable one. */
export function templateProblems(def: TemplateDef, subject: string, body: string): string[] {
  const problems: string[] = [];
  const known = new Set(def.variables.map((v) => v.name));
  const unknown = [...new Set([...usedVariables(subject), ...usedVariables(body)])].filter(
    (n) => !known.has(n),
  );
  if (unknown.length)
    problems.push(
      `Variable(s) inconnue(s) : ${unknown.map((n) => `{{${n}}}`).join(', ')}. Utilisez le bouton « Insérer une variable ».`,
    );
  for (const name of usedVariables(subject)) {
    const v = def.variables.find((x) => x.name === name);
    if (v && v.kind !== 'text')
      problems.push(
        `{{${name}}} ne peut pas être dans l’objet : il n’accepte que du texte simple.`,
      );
  }
  problems.push(...attributeProblems(def, body));
  for (const v of def.variables)
    if (v.required && !usedVariables(body).includes(v.name))
      problems.push(`{{${v.name}}} est indispensable dans le message (${v.label}).`);
  return problems;
}

/** The values the preview shows, from the samples of the variables. */
export function sampleValues(def: TemplateDef): Values {
  return Object.fromEntries(def.variables.map((v) => [v.name, v.sample]));
}

// --- The common layout ------------------------------------------------------------------------

export const emailLayoutSchema = z.object({
  headerImageId: z.string().uuid().nullable(),
  headerAlt: z.string().trim().max(120).default(''),
  footerHtml: z.string().max(EMAIL_LIMITS.footer),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur au format #RRGGBB.'),
});
export type EmailLayout = z.infer<typeof emailLayoutSchema>;

export const DEFAULT_EMAIL_LAYOUT: EmailLayout = {
  headerImageId: null,
  headerAlt: 'Épicafé de Montjavoult',
  footerHtml: '<p>Épicafé de Montjavoult</p>',
  accentColor: '#14532d',
};

/** The address of an image of the library, as it is written in the editor and in the templates. */
export const EMAIL_ASSET_PATH = '/api/v1/email-assets/';
export const EMAIL_ASSET_RE =
  /\/api\/v1\/email-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
/** The images a piece of HTML uses. */
export function assetIdsIn(source: string): string[] {
  return [...new Set([...source.matchAll(EMAIL_ASSET_RE)].map((m) => m[1]!.toLowerCase()))];
}

export interface EmailTemplateRow {
  key: string;
  label: string;
  audience: TemplateAudience;
  description: string;
  /** Edited by an administrator (false: the wording of the application). */
  customized: boolean;
  updatedAt: string | null;
}

export interface EmailTemplateDetail extends EmailTemplateRow {
  subject: string;
  body: string;
  defaultSubject: string;
  defaultBody: string;
  variables: TemplateVariable[];
}

export interface EmailPreview {
  subject: string;
  html: string;
  text: string;
  problems: string[];
}

export interface EmailAssetInfo {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  createdAt: string;
  /** Used by the layout or by a template: it cannot be deleted. */
  usedBy: string[];
}
