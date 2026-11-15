import { eq } from 'drizzle-orm';
import { pdfTemplate, type DbOrTx } from '@episoft/db';
import {
  effectivePdfConfig,
  pdfTemplateDef,
  pdfTemplateSaveSchema,
  type PdfDocKey,
  type PdfTemplateConfig,
  type Settings,
  type Values,
} from '@episoft/shared';
import { drawPdfHtml, heightOfPdfHtml } from './pdf-html';
import type { Doc } from './pdf';

// What the administrators changed in a PDF document (packages/shared/src/pdf-templates.ts), read when
// the document is made. A template that cannot be read is the one of the application: a document
// can always be made.

export interface LoadedPdfConfig {
  config: PdfTemplateConfig;
  customized: boolean;
  updatedAt: Date | null;
}

export async function loadPdfConfig(db: DbOrTx, key: PdfDocKey): Promise<LoadedPdfConfig> {
  const def = pdfTemplateDef(key)!;
  const [row] = await db.select().from(pdfTemplate).where(eq(pdfTemplate.key, key));
  if (!row) return { config: effectivePdfConfig(def, null), customized: false, updatedAt: null };
  const saved = pdfTemplateSaveSchema.partial().safeParse(row.config);
  return {
    config: effectivePdfConfig(def, saved.success ? saved.data : null),
    customized: true,
    updatedAt: row.updatedAt,
  };
}

/** The settings of the association, as the variables of the letterhead. */
export function associationValues(identity: Settings['association.identity']): Values {
  const place = [identity.postcode, identity.city].filter(Boolean).join(' - ');
  return {
    association_nom: identity.name,
    association_rue: identity.street ?? '',
    association_code_postal: identity.postcode ?? '',
    association_ville: identity.city ?? '',
    association_adresse: place,
    siren: identity.siren ?? '',
    rna: identity.rna ?? '',
    association_email: identity.email ?? '',
    association_telephone: identity.phone ?? '',
  };
}

const PAGE_HEIGHT = 841.89;
const FOOTER_MARGIN = 14;

/**
 * Writes the footer zone at the bottom of every page: now on the current page, and on each page
 * that is added. Returns its height, so that the content can stop above it.
 */
export function installFooter(doc: Doc, html: string, x: number, width: number): number {
  if (!html.trim()) return 0;
  const height = heightOfPdfHtml(doc, html, width);
  const draw = () => {
    const { x: cx, y: cy } = doc;
    // Under the usual bottom margin: the text must not make a page of its own.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    drawPdfHtml(doc, html, x, PAGE_HEIGHT - FOOTER_MARGIN - height, width);
    doc.page.margins.bottom = bottom;
    doc.x = cx;
    doc.y = cy;
  };
  draw();
  doc.on('pageAdded', draw);
  return height + FOOTER_MARGIN;
}
