import { eq, inArray } from 'drizzle-orm';
import { emailAsset, emailLayout, emailTemplate, type DbOrTx } from '@episoft/db';
import {
  assetIdsIn,
  DEFAULT_EMAIL_LAYOUT,
  EMAIL_ASSET_PATH,
  escapeHtmlText,
  fillHtml,
  fillText,
  htmlToText,
  oneLine,
  templateDef,
  type EmailLayout,
  type EmailTemplateKey,
  type Values,
} from '@episoft/shared';
import { loadSettings } from '../modules/admin/settings-store';
import { queueEmail, type EmailAttachment, type OutgoingEmail } from './mail';

// Writes an e-mail from its template: the wording (edited by the administrators, or the one of the
// application), the variables filled in, the common layout around it, the images embedded.

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

export interface TemplateSource {
  subject: string;
  body: string;
}

export async function loadLayout(db: DbOrTx): Promise<EmailLayout> {
  const [row] = await db.select().from(emailLayout).where(eq(emailLayout.id, 1));
  if (!row) return DEFAULT_EMAIL_LAYOUT;
  return {
    headerImageId: row.headerImageId,
    headerAlt: row.headerAlt,
    footerHtml: row.footerHtml,
    accentColor: row.accentColor,
  };
}

/** The wording an administrator saved, or the one of the application. */
export async function loadTemplate(
  db: DbOrTx,
  key: string,
): Promise<TemplateSource & { customized: boolean; updatedAt: Date | null }> {
  const def = templateDef(key);
  if (!def) throw new Error(`Modèle de courriel inconnu : ${key}`);
  const [row] = await db.select().from(emailTemplate).where(eq(emailTemplate.key, key));
  return row
    ? { subject: row.subject, body: row.bodyHtml, customized: true, updatedAt: row.updatedAt }
    : { subject: def.subject, body: def.body, customized: false, updatedAt: null };
}

/**
 * The page of the e-mail: a header (the image of the library, or the name of the association on the
 * accent colour), the message, a footer. Tables and inline styles: what mail readers understand.
 */
export function layoutHtml(
  layout: EmailLayout,
  body: string,
  subject: string,
  associationName: string,
): string {
  const accent = layout.accentColor;
  const header = layout.headerImageId
    ? `<img src="${EMAIL_ASSET_PATH}${layout.headerImageId}" alt="${escapeHtmlText(layout.headerAlt)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0">`
    : `<div style="padding:18px 24px;font-size:20px;font-weight:600;color:#ffffff">${escapeHtmlText(associationName)}</div>`;
  const styledBody = body
    .replace(/<h2>/g, `<h2 style="font-size:18px;margin:0 0 12px;color:${accent}">`)
    .replace(/<h1>/g, `<h1 style="font-size:22px;margin:0 0 12px;color:${accent}">`)
    .replace(/<a href=/g, `<a style="color:${accent}" href=`)
    // An image of the message never overflows it, whatever its size.
    .replace(/<img(?![^>]*\bstyle=)/g, '<img style="max-width:100%;height:auto;border:0"');
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtmlText(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f3f5f3">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f3"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;color:#1c2b22">` +
    `<tr><td style="background:${accent};padding:0;text-align:center">${header}</td></tr>` +
    `<tr><td style="padding:24px;font-size:15px;line-height:1.5">${styledBody}</td></tr>` +
    `<tr><td style="padding:16px 24px;background:#f7f8f7;border-top:1px solid #e3e8e4;font-size:12px;line-height:1.4;color:#5b6b61">${layout.footerHtml}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/**
 * The images of the library an HTML uses. Sent: embedded in the message (`cid:`), so that they
 * show without a public address. Preview: written as data, so that a sandboxed frame shows them.
 */
async function embedImages(
  db: DbOrTx,
  html: string,
  mode: 'send' | 'preview',
): Promise<{ html: string; attachments: EmailAttachment[] }> {
  const ids = assetIdsIn(html);
  if (!ids.length) return { html, attachments: [] };
  const rows = await db.select().from(emailAsset).where(inArray(emailAsset.id, ids));
  const attachments: EmailAttachment[] = [];
  let out = html;
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    const path = `${EMAIL_ASSET_PATH}${id}`;
    if (!row) {
      // The image was deleted: its tag goes, the message still reads.
      out = out.replace(new RegExp(`<img[^>]*${path}[^>]*>`, 'gi'), '');
      continue;
    }
    const base64 = row.bytes.toString('base64');
    if (mode === 'preview') {
      out = out.split(path).join(`data:${row.mime};base64,${base64}`);
    } else {
      const cid = `asset-${id}@episoft`;
      out = out.split(path).join(`cid:${cid}`);
      attachments.push({
        filename: row.name,
        contentType: row.mime,
        contentBase64: base64,
        cid,
      });
    }
  }
  return { html: out, attachments };
}

/** A list of lines as the HTML fragment a variable holds (each line is escaped). */
export const htmlList = (lines: readonly string[]) =>
  `<ul>${lines.map((l) => `<li>${escapeHtmlText(l)}</li>`).join('')}</ul>`;

/** Subject only: what the « one alert an hour » rule compares. */
export async function renderSubject(
  db: DbOrTx,
  key: EmailTemplateKey,
  values: Values,
): Promise<string> {
  const def = templateDef(key)!;
  try {
    const tpl = await db.transaction((sp) => loadTemplate(sp, key));
    return oneLine(fillText(tpl.subject, values, def.variables));
  } catch {
    // Same fallback as the e-mail itself: an alert is never lost because the wording is unreadable.
    return oneLine(fillText(def.subject, values, def.variables));
  }
}

export async function renderEmail(
  db: DbOrTx,
  key: EmailTemplateKey,
  values: Values,
  opts: { preview?: boolean; draft?: TemplateSource & { layout?: EmailLayout } } = {},
): Promise<RenderedEmail> {
  const def = templateDef(key)!;
  const tpl = opts.draft ?? (await loadTemplate(db, key));
  const layout = opts.draft?.layout ?? (await loadLayout(db));
  const name = (await loadSettings(db))['association.identity'].name;
  const subject = oneLine(fillText(tpl.subject, values, def.variables));
  const body = fillHtml(tpl.body, values, def.variables);
  const text =
    fillText(htmlToText(tpl.body), values, def.variables) +
    (layout.footerHtml ? `\n\n--\n${htmlToText(layout.footerHtml)}` : '');
  const page = layoutHtml(layout, body, subject, name);
  const embedded = await embedImages(db, page, opts.preview ? 'preview' : 'send');
  return { subject, html: embedded.html, text, attachments: embedded.attachments };
}

/** The wording of a template as plain text, variables filled: what a person edits before sending. */
export async function renderPlainDraft(
  db: DbOrTx,
  key: EmailTemplateKey,
  values: Values,
): Promise<{ subject: string; message: string }> {
  const def = templateDef(key)!;
  const tpl = await loadTemplate(db, key);
  return {
    subject: oneLine(fillText(tpl.subject, values, def.variables)),
    message: fillText(htmlToText(tpl.body), values, def.variables),
  };
}

/** A message typed by a person (plain text, escaped) inside the common layout. */
export async function renderPlainEmail(
  db: DbOrTx,
  subject: string,
  message: string,
): Promise<RenderedEmail> {
  const layout = await loadLayout(db);
  const name = (await loadSettings(db))['association.identity'].name;
  const body = message
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtmlText(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const embedded = await embedImages(db, layoutHtml(layout, body, subject, name), 'send');
  const text = message + (layout.footerHtml ? `\n\n--\n${htmlToText(layout.footerHtml)}` : '');
  return { subject, html: embedded.html, text, attachments: embedded.attachments };
}

/**
 * The e-mail written from the wording and the layout of the application only: no database read, so
 * it cannot fail the way a read of the edited wording can. The last resort when that read fails.
 */
export function renderDefaultEmail(key: EmailTemplateKey, values: Values): RenderedEmail {
  const def = templateDef(key)!;
  const subject = oneLine(fillText(def.subject, values, def.variables));
  const html = layoutHtml(
    DEFAULT_EMAIL_LAYOUT,
    fillHtml(def.body, values, def.variables),
    subject,
    DEFAULT_EMAIL_LAYOUT.headerAlt,
  );
  const text =
    fillText(htmlToText(def.body), values, def.variables) +
    `\n\n--\n${htmlToText(DEFAULT_EMAIL_LAYOUT.footerHtml)}`;
  return { subject, html, text, attachments: [] };
}

/**
 * Writes the e-mail of a template in the outbox, in the transaction of the business change. The
 * e-mail is never worth the change: this is called inside a sale, a top-up, a closing. If the
 * wording cannot be read or rendered (a savepoint keeps the transaction alive), the message goes out
 * in the wording of the application, so the business change is recorded all the same.
 */
export async function queueTemplatedEmail(
  db: DbOrTx,
  key: EmailTemplateKey,
  to: string,
  values: Values,
  extra: { attachments?: EmailAttachment[] } = {},
): Promise<void> {
  let mail: RenderedEmail;
  try {
    mail = await db.transaction((sp) => renderEmail(sp, key, values));
  } catch (err) {
    console.error(`courriel « ${key} » : modèle illisible, texte d’origine utilisé`, err);
    mail = renderDefaultEmail(key, values);
  }
  const email: OutgoingEmail = {
    to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: [...mail.attachments, ...(extra.attachments ?? [])],
  };
  await queueEmail(db, email);
}
