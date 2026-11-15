import { eq } from 'drizzle-orm';
import { emailAsset, pdfTemplate, type DbOrTx } from '@episoft/db';
import {
  effectivePdfConfig,
  pdfTemplateDef,
  pdfTemplateSaveSchema,
  type PdfDocKey,
  type PdfTemplateConfig,
  type Settings,
  type Values,
} from '@episoft/shared';
import { loadSettings } from '../modules/admin/settings-store';
import { loadHeaderLogo } from './email-render';
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

// --- The logo -------------------------------------------------------------------------------------

/**
 * The logo of the PDF documents: the image of the library chosen in Administration › Documents PDF,
 * or, by default and when that image is gone or is not one a PDF can draw (PNG, JPEG), the header
 * image of the e-mails. Null when there is none.
 */
export async function loadPdfLogo(db: DbOrTx): Promise<Buffer | null> {
  const choice = (await loadSettings(db))['documents.logo'];
  if (choice.source === 'IMAGE' && choice.imageId) {
    const [img] = await db
      .select({ mime: emailAsset.mime, bytes: emailAsset.bytes })
      .from(emailAsset)
      .where(eq(emailAsset.id, choice.imageId));
    if (img && ['image/png', 'image/jpeg'].includes(img.mime)) return img.bytes;
  }
  return loadHeaderLogo(db);
}

/** Width and height of a PNG or a JPEG, read in its header; throws on anything else. */
export function imageSize(b: Buffer): { width: number; height: number } {
  if (b.length > 24 && b.subarray(1, 4).toString() === 'PNG')
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      // Start of frame (not the tables 0xc4, 0xc8, 0xcc): height, then width.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  throw new Error('image illisible');
}

/**
 * A header zone on the left and the logo on the right (when there is one): the zone is narrowed so
 * that it does not run under the logo. Returns where the content may start.
 */
export function drawHeader(
  doc: Doc,
  html: string,
  logo: Buffer | null,
  x: number,
  y: number,
  width: number,
  logoWidth = 130,
): number {
  let logoBottom = y;
  if (logo) {
    try {
      const size = imageSize(logo);
      doc.image(logo, x + width - logoWidth, y, { width: logoWidth });
      logoBottom = y + (logoWidth * size.height) / size.width + 8;
    } catch {
      // An image the PDF cannot read: the document is made without it.
      logo = null;
    }
  }
  const textWidth = logo ? width - logoWidth - 16 : width;
  return Math.max(drawPdfHtml(doc, html, x, y, textWidth), logoBottom);
}
