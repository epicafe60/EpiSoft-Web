import { z } from 'zod';
import {
  fillHtml,
  fillText,
  oneLine,
  usedVariables,
  type TemplateVariable,
  type Values,
} from './email-templates';

// PDF templates: what the documents the application makes say (header, notes, footer), with
// variables (`{{numero}}`) filled in when the PDF is made, which columns the tables show, and in
// which order. The layout itself (where the logo goes, how the table is drawn) stays in the code.
// The wording below is the default; the administrators change it in the application and can put it
// back. Pure rules.

export type PdfDocKey = 'purchase_order' | 'cash_closing' | 'report';

/** A block of text of the page the administrators write (rich text, with variables). */
export interface PdfZoneDef {
  key: string;
  label: string;
  /** Where it sits on the page, for the person who edits it. */
  hint: string;
  /** HTML (the subset of pdf-html: paragraphs, bold, italic, underline, lists, alignment, colour). */
  default: string;
}

/** A column of the table of a document. */
export interface PdfColumnDef {
  key: string;
  /** What the header says unless the administrators change it. */
  label: string;
  align: 'left' | 'right';
  /** Width in points; the column that takes what is left has none. */
  width?: number;
  /** Cannot be taken off (a table without its product is useless). */
  required?: boolean;
  /** Shown by default. */
  shown: boolean;
}

/** A short text of the page (the label of the total), edited as plain text. */
export interface PdfLabelDef {
  key: string;
  label: string;
  default: string;
}

export interface PdfTemplateDef {
  key: PdfDocKey;
  label: string;
  description: string;
  variables: TemplateVariable[];
  zones: PdfZoneDef[];
  /** The columns that can be shown, in their default order; none when the document has no choice. */
  columns: PdfColumnDef[];
  labels: PdfLabelDef[];
  /** The logo of the association can be shown at the top right. */
  logo: boolean;
}

const text = (name: string, label: string, sample: string): TemplateVariable => ({
  name,
  label,
  sample,
  kind: 'text',
});

/** What the letterhead of the association says: the variables are the settings of the association. */
const ASSOCIATION_VARIABLES: TemplateVariable[] = [
  text('association_nom', 'Nom de l’association', 'Épicafé de Montjavoult'),
  text('association_rue', 'Rue', '9 bis rue de la Mairie'),
  text('association_code_postal', 'Code postal', '60240'),
  text('association_ville', 'Ville', 'Montjavoult'),
  text('association_adresse', 'Adresse complète (code postal et ville)', '60240 - Montjavoult'),
  text('siren', 'SIREN', '123456789'),
  text('rna', 'RNA', 'W123456789'),
  text('association_email', 'Courriel de l’association', 'contact@exemple.fr'),
  text('association_telephone', 'Téléphone de l’association', '01 02 03 04 05'),
];

const LETTERHEAD =
  '<p><strong>{{association_nom}}</strong><br>{{association_rue}}<br>{{association_adresse}}</p>' +
  '<p>SIREN : {{siren}}<br>RNA : {{rna}}</p>' +
  '<p>Email : {{association_email}}<br>Tel : {{association_telephone}}</p>';

export const PDF_TEMPLATES = [
  {
    key: 'purchase_order',
    label: 'Bon de commande fournisseur',
    description:
      'Le PDF joint à la commande envoyée au fournisseur : en-tête, fournisseur, tableau des produits, total.',
    logo: true,
    variables: [
      ...ASSOCIATION_VARIABLES,
      text('numero', 'Numéro de la commande', 'CF-2026-0001'),
      text('date', 'Date de la commande', '06/07/2026'),
      text('fournisseur_nom', 'Nom du fournisseur', 'M’PARNATURE'),
      text('fournisseur_rue', 'Rue du fournisseur', '30 Rue Parmentier'),
      text(
        'fournisseur_code_postal_ville',
        'Code postal et ville du fournisseur',
        '60590 Sérifontaine',
      ),
      text('fournisseur_telephone', 'Téléphone du fournisseur', '03 44 00 00 00'),
      text('fournisseur_email', 'Courriel du fournisseur', 'contact@mparnature.example'),
      text('total_ht', 'Total HT', '143,33'),
      text('total_tva', 'Total de la TVA', '28,67'),
      text('total', 'Total TTC', '172,00'),
      text('nombre_lignes', 'Nombre de lignes', '9'),
      text('commentaire', 'Commentaire de la commande', 'Livraison mardi matin.'),
    ],
    zones: [
      {
        key: 'header',
        label: 'En-tête (à gauche)',
        hint: 'En haut à gauche, à côté du logo.',
        default:
          '<p><strong>Association<br>{{association_nom}}</strong></p>' +
          '<p>{{association_rue}}<br>{{association_adresse}}</p>' +
          '<p>SIREN : {{siren}}<br>RNA : {{rna}}</p>' +
          '<p>Email : {{association_email}}<br>Tel : {{association_telephone}}</p>' +
          '<p>Commande {{numero}} du {{date}}</p>',
      },
      {
        key: 'supplier',
        label: 'Fournisseur',
        hint: 'À droite, sous le logo.',
        default:
          '<p>{{fournisseur_nom}}<br>{{fournisseur_rue}}<br>{{fournisseur_code_postal_ville}}</p>',
      },
      {
        key: 'after_table',
        label: 'Sous le tableau',
        hint: 'Sous le total : un commentaire, des conditions de livraison.',
        default: '<p>{{commentaire}}</p>',
      },
      {
        key: 'footer',
        label: 'Bas de page',
        hint: 'En bas de chaque page.',
        default: '',
      },
    ],
    columns: [
      { key: 'ref', label: 'Réf. fournisseur', align: 'left', width: 80, shown: false },
      { key: 'code', label: 'Code', align: 'left', width: 50, shown: false },
      { key: 'name', label: 'Désignation du produit', align: 'left', required: true, shown: true },
      { key: 'unit_excl', label: 'P.A HT', align: 'right', width: 62, shown: false },
      { key: 'vat', label: 'TVA', align: 'right', width: 44, shown: false },
      { key: 'unit_incl', label: 'P.A TTC', align: 'right', width: 70, shown: true },
      { key: 'qty', label: 'Quantité', align: 'right', width: 62, shown: true },
      { key: 'total_excl', label: 'Total HT', align: 'right', width: 70, shown: false },
      { key: 'total_incl', label: 'Total', align: 'right', width: 70, shown: true },
    ],
    labels: [{ key: 'total', label: 'Libellé du total', default: 'Total de la commande' }],
  },
  {
    key: 'cash_closing',
    label: 'Rapport de clôture de caisse',
    description:
      'Le PDF de fin de session : envoyé au trésorier à chaque clôture et téléchargeable depuis la session.',
    logo: true,
    variables: [
      ...ASSOCIATION_VARIABLES,
      text('date_session', 'Date de la session', '14/11/2026'),
      text('ouverture', 'Ouverture', '14/11/2026 09:00'),
      text('cloture', 'Clôture (ou « session ouverte »)', '14/11/2026 18:30'),
    ],
    zones: [
      {
        key: 'header',
        label: 'En-tête',
        hint: 'En haut de la première page.',
        default:
          LETTERHEAD +
          '<h2>Rapport de clôture — session du {{date_session}}</h2>' +
          '<p>Ouverture : {{ouverture}} · clôture : {{cloture}}</p>',
      },
      { key: 'footer', label: 'Bas de page', hint: 'En bas de chaque page.', default: '' },
    ],
    columns: [],
    labels: [],
  },
  {
    key: 'report',
    label: 'Rapports (comptabilité, statistiques)',
    description:
      'Les PDF des rapports : journal, grand livre, bilan, ventes, stocks… Le tableau dépend du rapport.',
    logo: true,
    variables: [
      ...ASSOCIATION_VARIABLES,
      text('titre', 'Titre du rapport', 'Journal des écritures'),
      text('sous_titre', 'Sous-titre (période, filtres)', 'Du 01/01/2026 au 31/12/2026'),
    ],
    zones: [
      {
        key: 'header',
        label: 'En-tête',
        hint: 'En haut de la première page.',
        default: LETTERHEAD + '<h2>{{titre}}</h2><p>{{sous_titre}}</p>',
      },
      { key: 'footer', label: 'Bas de page', hint: 'En bas de chaque page.', default: '' },
    ],
    columns: [],
    labels: [],
  },
] as const satisfies readonly PdfTemplateDef[];

export const PDF_DOC_KEYS = PDF_TEMPLATES.map((t) => t.key) as [PdfDocKey, ...PdfDocKey[]];

export function pdfTemplateDef(key: string): PdfTemplateDef | undefined {
  return (PDF_TEMPLATES as readonly PdfTemplateDef[]).find((t) => t.key === key);
}

// --- What is saved -----------------------------------------------------------------------------

export const PDF_LIMITS = {
  zone: 6_000,
  columnLabel: 40,
  label: 80,
  columns: 12,
} as const;

export const pdfColumnChoiceSchema = z.object({
  key: z.string().min(1).max(40),
  label: z
    .string()
    .trim()
    .min(1, 'Un en-tête de colonne ne peut pas être vide.')
    .max(PDF_LIMITS.columnLabel),
});

export const pdfTemplateSaveSchema = z.object({
  zones: z.record(z.string().max(40), z.string().max(PDF_LIMITS.zone)),
  /** The columns shown, in order. Empty for a document whose table has no choice. */
  columns: z.array(pdfColumnChoiceSchema).max(PDF_LIMITS.columns),
  labels: z.record(z.string().max(40), z.string().trim().max(PDF_LIMITS.label)),
  logo: z.boolean(),
});
export type PdfTemplateConfig = z.infer<typeof pdfTemplateSaveSchema>;

/** The template as the application ships it. */
export function defaultPdfConfig(def: PdfTemplateDef): PdfTemplateConfig {
  return {
    zones: Object.fromEntries(def.zones.map((z) => [z.key, z.default])),
    columns: def.columns.filter((c) => c.shown).map((c) => ({ key: c.key, label: c.label })),
    labels: Object.fromEntries(def.labels.map((l) => [l.key, l.default])),
    logo: def.logo,
  };
}

/**
 * What a saved template says, completed by the default for whatever it does not hold (a zone added
 * since, a column that no longer exists is dropped): a document can always be made.
 */
export function effectivePdfConfig(
  def: PdfTemplateDef,
  saved: Partial<PdfTemplateConfig> | null | undefined,
): PdfTemplateConfig {
  const base = defaultPdfConfig(def);
  if (!saved) return base;
  const known = new Set(def.columns.map((c) => c.key));
  const columns = (saved.columns ?? base.columns).filter((c) => known.has(c.key));
  // A column that cannot be taken off comes back even if a saved template lost it.
  for (const c of def.columns)
    if (c.required && !columns.some((x) => x.key === c.key))
      columns.unshift({ key: c.key, label: c.label });
  return {
    zones: { ...base.zones, ...(saved.zones ?? {}) },
    columns: def.columns.length ? (columns.length ? columns : base.columns) : [],
    labels: { ...base.labels, ...(saved.labels ?? {}) },
    logo: def.logo ? (saved.logo ?? base.logo) : false,
  };
}

/** What is wrong with a template, in words: unknown variables, columns, zones; a column missing. */
export function pdfTemplateProblems(def: PdfTemplateDef, config: PdfTemplateConfig): string[] {
  const problems: string[] = [];
  const zoneKeys = new Set(def.zones.map((z) => z.key));
  for (const k of Object.keys(config.zones))
    if (!zoneKeys.has(k)) problems.push(`Zone inconnue : ${k}.`);
  const known = new Set(def.variables.map((v) => v.name));
  for (const z of def.zones) {
    const unknown = usedVariables(config.zones[z.key] ?? '').filter((n) => !known.has(n));
    if (unknown.length)
      problems.push(
        `${z.label} : variable(s) inconnue(s) ${unknown.map((n) => `{{${n}}}`).join(', ')}. Utilisez le bouton « Insérer une variable ».`,
      );
  }
  for (const k of Object.keys(config.labels))
    if (!def.labels.some((l) => l.key === k)) problems.push(`Libellé inconnu : ${k}.`);
  const columnKeys = new Set(def.columns.map((c) => c.key));
  const seen = new Set<string>();
  for (const c of config.columns) {
    if (!columnKeys.has(c.key)) problems.push(`Colonne inconnue : ${c.key}.`);
    else if (seen.has(c.key)) problems.push(`La colonne « ${c.label} » est en double.`);
    seen.add(c.key);
  }
  for (const c of def.columns)
    if (c.required && !seen.has(c.key))
      problems.push(`La colonne « ${c.label} » est indispensable.`);
  if (!def.columns.length && config.columns.length)
    problems.push('Ce document n’a pas de colonnes à choisir.');
  if (def.columns.length && !config.columns.length)
    problems.push('Choisissez au moins une colonne.');
  if (config.logo && !def.logo) problems.push('Ce document n’a pas de logo.');
  return problems;
}

// --- Filling the zones --------------------------------------------------------------------------

const TOKEN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const BLOCK = /<(p|h1|h2|h3|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

/**
 * A line with variables disappears when every one of them is empty: no « SIREN : » left alone when
 * the association has none. A line (a paragraph, or what lies between two line breaks) without any
 * variable stays. A paragraph left without a line goes.
 */
export function dropEmptyLines(html: string, values: Values): string {
  return html.replace(BLOCK, (_m, tag: string, attrs: string, inner: string) => {
    const kept = inner.split(/<br\s*\/?>/i).filter((line) => {
      const names = [...line.matchAll(TOKEN)].map((m) => m[1]!);
      return names.length === 0 || names.some((n) => (values[n] ?? '').trim() !== '');
    });
    return kept.length ? `<${tag}${attrs}>${kept.join('<br>')}</${tag}>` : '';
  });
}

/** The HTML of a zone, ready to draw: empty lines dropped, variables written (texts escaped). */
export function fillZone(html: string, values: Values, vars: readonly TemplateVariable[]): string {
  return fillHtml(dropEmptyLines(html, values), values, vars);
}

/** A short text (a label) with its variables, on one line. */
export const fillLabel = (source: string, values: Values, vars: readonly TemplateVariable[]) =>
  oneLine(fillText(source, values, vars));

/** The values the preview shows, from the samples of the variables. */
export function pdfSampleValues(def: PdfTemplateDef): Values {
  return Object.fromEntries(def.variables.map((v) => [v.name, v.sample]));
}

// --- What the screens receive ------------------------------------------------------------------

export interface PdfTemplateRow {
  key: PdfDocKey;
  label: string;
  description: string;
  /** Edited by an administrator (false: the wording of the application). */
  customized: boolean;
  updatedAt: string | null;
}

export interface PdfTemplateDetail extends PdfTemplateRow {
  config: PdfTemplateConfig;
  defaults: PdfTemplateConfig;
  variables: TemplateVariable[];
  zones: PdfZoneDef[];
  columns: PdfColumnDef[];
  labels: PdfLabelDef[];
  logo: boolean;
}
