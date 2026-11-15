import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { emailAsset, emailLayout, emailTemplate, member, type Db } from '@episoft/db';
import {
  assetIdsIn,
  contentMatchesType,
  EMAIL_LIMITS,
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATES,
  emailLayoutSchema,
  emailTemplateSaveSchema,
  sampleValues,
  templateDef,
  templateProblems,
  type EmailAssetInfo,
  type EmailLayout,
  type EmailPreview,
  type EmailTemplateDetail,
  type EmailTemplateKey,
  type EmailTemplateRow,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { loadLayout, loadTemplate, renderEmail } from '../../lib/email-render';
import { sanitizeEmailHtml } from '../../lib/email-sanitize';
import { headerFileName } from '../../lib/files';
import { queueEmail } from '../../lib/mail';
import { badRequest, conflict, notFound } from '../../lib/problem';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const keyParams = z.object({ key: z.enum(EMAIL_TEMPLATE_KEYS) });
const idParams = z.object({ id: z.string().uuid() });

/**
 * The e-mails of the application, edited by the administrators: the wording of each one (subject,
 * message, with variables), the layout common to all (header image, footer, colour) and the library
 * of images that go inside the messages. What is saved is cleaned (email-sanitize.ts) and checked
 * against the variables the e-mail knows; deleting a wording puts the original back.
 */
export const emailTemplateRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const admin = { preHandler: app.requireRoles('ADMIN') };

  app.addContentTypeParser(
    IMAGE_TYPES,
    { parseAs: 'buffer', bodyLimit: EMAIL_LIMITS.imageBytes },
    (_req, body, done) => done(null, body),
  );

  const detail = async (key: EmailTemplateKey): Promise<EmailTemplateDetail> => {
    const def = templateDef(key)!;
    const tpl = await loadTemplate(db, key);
    return {
      key: def.key,
      label: def.label,
      audience: def.audience,
      description: def.description,
      customized: tpl.customized,
      updatedAt: tpl.updatedAt?.toISOString() ?? null,
      subject: tpl.subject,
      body: tpl.body,
      defaultSubject: def.subject,
      defaultBody: def.body,
      variables: def.variables,
    };
  };

  // --- Templates -------------------------------------------------------------------------

  app.get('/email-templates', admin, async (): Promise<EmailTemplateRow[]> => {
    const rows = await db.select().from(emailTemplate);
    return EMAIL_TEMPLATES.map((d) => {
      const row = rows.find((r) => r.key === d.key);
      return {
        key: d.key,
        label: d.label,
        audience: d.audience,
        description: d.description,
        customized: !!row,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  });

  app.get('/email-templates/:key', { ...admin, schema: { params: keyParams } }, async (req) =>
    detail(req.params.key),
  );

  app.put(
    '/email-templates/:key',
    { ...admin, schema: { params: keyParams, body: emailTemplateSaveSchema } },
    async (req) => {
      const def = templateDef(req.params.key)!;
      const body = sanitizeEmailHtml(req.body.body);
      const problems = templateProblems(def, req.body.subject, body);
      if (problems.length)
        throw badRequest(
          problems[0]!,
          problems.map((message) => ({ path: 'body', message })),
        );
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(emailTemplate)
          .where(eq(emailTemplate.key, def.key))
          .for('update');
        await tx
          .insert(emailTemplate)
          .values({
            key: def.key,
            subject: req.body.subject,
            bodyHtml: body,
            updatedBy: req.user!.id,
          })
          .onConflictDoUpdate({
            target: emailTemplate.key,
            set: {
              subject: req.body.subject,
              bodyHtml: body,
              updatedBy: req.user!.id,
              updatedAt: new Date(),
            },
          });
        await audit(tx, req, {
          action: 'email_template.update',
          entity: 'email_template',
          entityId: def.key,
          before: before ? { subject: before.subject } : null,
          after: { label: def.label, subject: req.body.subject },
        });
      });
      return detail(req.params.key);
    },
  );

  /** Puts the wording of the application back. */
  app.delete(
    '/email-templates/:key',
    { ...admin, schema: { params: keyParams } },
    async (req, reply) => {
      const def = templateDef(req.params.key)!;
      await db.transaction(async (tx) => {
        const [gone] = await tx
          .delete(emailTemplate)
          .where(eq(emailTemplate.key, def.key))
          .returning({ subject: emailTemplate.subject });
        if (!gone) return;
        await audit(tx, req, {
          action: 'email_template.reset',
          entity: 'email_template',
          entityId: def.key,
          before: { subject: gone.subject },
          after: { label: def.label },
        });
      });
      return reply.status(204).send();
    },
  );

  /** What the e-mail will look like, with the samples of its variables: the draft or the saved one. */
  app.post(
    '/email-templates/:key/preview',
    {
      ...admin,
      schema: {
        params: keyParams,
        body: z.object({
          subject: z.string().max(EMAIL_LIMITS.subject).optional(),
          body: z.string().max(EMAIL_LIMITS.body).optional(),
          layout: emailLayoutSchema.optional(),
        }),
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req): Promise<EmailPreview> => {
      const def = templateDef(req.params.key)!;
      const saved = await loadTemplate(db, def.key);
      const subject = req.body.subject ?? saved.subject;
      const body = sanitizeEmailHtml(req.body.body ?? saved.body);
      const layout: EmailLayout = req.body.layout
        ? { ...req.body.layout, footerHtml: sanitizeEmailHtml(req.body.layout.footerHtml) }
        : await loadLayout(db);
      const mail = await renderEmail(db, req.params.key, sampleValues(def), {
        preview: true,
        draft: { subject, body, layout },
      });
      return {
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        problems: templateProblems(def, subject, body),
      };
    },
  );

  /** A test message to the administrator who asks, with the samples: to see it in a real mailbox. */
  app.post(
    '/email-templates/:key/test',
    {
      ...admin,
      schema: { params: keyParams },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const def = templateDef(req.params.key)!;
      const [me] = await db
        .select({ email: member.email })
        .from(member)
        .where(eq(member.id, req.user!.impersonator?.id ?? req.user!.id));
      if (!me?.email) throw badRequest('Votre fiche n’a pas d’adresse de courriel.');
      const mail = await renderEmail(db, req.params.key, sampleValues(def));
      await db.transaction(async (tx) => {
        await queueEmail(tx, {
          to: me.email!,
          subject: `[Essai] ${mail.subject}`,
          html: mail.html,
          text: mail.text,
          attachments: mail.attachments,
        });
        await audit(tx, req, {
          action: 'email_template.test',
          entity: 'email_template',
          entityId: def.key,
          after: { label: def.label },
        });
      });
      return reply.status(204).send();
    },
  );

  // --- Common layout -------------------------------------------------------------------------

  app.get('/email-layout', admin, async (): Promise<EmailLayout> => loadLayout(db));

  app.put('/email-layout', { ...admin, schema: { body: emailLayoutSchema } }, async (req) => {
    const footerHtml = sanitizeEmailHtml(req.body.footerHtml);
    if (req.body.headerImageId) {
      const [img] = await db
        .select({ id: emailAsset.id })
        .from(emailAsset)
        .where(eq(emailAsset.id, req.body.headerImageId));
      if (!img) throw badRequest('L’image d’en-tête n’existe plus : choisissez-en une autre.');
    }
    const value = { ...req.body, footerHtml };
    await db.transaction(async (tx) => {
      const before = await loadLayout(tx);
      await tx
        .insert(emailLayout)
        .values({ id: 1, ...value, updatedBy: req.user!.id })
        .onConflictDoUpdate({
          target: emailLayout.id,
          set: { ...value, updatedBy: req.user!.id, updatedAt: new Date() },
        });
      await audit(tx, req, {
        action: 'email_layout.update',
        entity: 'email_layout',
        entityId: '1',
        before: { accentColor: before.accentColor, headerImageId: before.headerImageId },
        after: { accentColor: value.accentColor, headerImageId: value.headerImageId },
      });
    });
    return loadLayout(db);
  });

  // --- Images --------------------------------------------------------------------------------

  /** Where each image is used: the layout, the wording of an e-mail. A used image is not deleted. */
  const usage = async (): Promise<Map<string, string[]>> => {
    const map = new Map<string, string[]>();
    const add = (id: string, where: string) => map.set(id, [...(map.get(id) ?? []), where]);
    const layout = await loadLayout(db);
    if (layout.headerImageId) add(layout.headerImageId, 'En-tête commun');
    for (const id of assetIdsIn(layout.footerHtml)) add(id, 'Pied de page commun');
    for (const row of await db.select().from(emailTemplate))
      for (const id of assetIdsIn(row.bodyHtml)) add(id, templateDef(row.key)?.label ?? row.key);
    return map;
  };

  app.get('/email-assets', admin, async (): Promise<EmailAssetInfo[]> => {
    const used = await usage();
    const rows = await db
      .select({
        id: emailAsset.id,
        name: emailAsset.name,
        mime: emailAsset.mime,
        createdAt: emailAsset.createdAt,
        size: emailAsset.bytes,
      })
      .from(emailAsset)
      .orderBy(desc(emailAsset.createdAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      mime: r.mime,
      bytes: r.size.length,
      createdAt: r.createdAt.toISOString(),
      usedBy: used.get(r.id) ?? [],
    }));
  });

  /** An image sent as is (PNG, JPEG, WebP, GIF), 500 KB at most; its name travels in a header. */
  app.post('/email-assets', admin, async (req) => {
    const mime = req.headers['content-type']?.split(';')[0] ?? '';
    // The content must be what the browser announced: no HTML or SVG passed off as an image.
    if (
      !IMAGE_TYPES.includes(mime) ||
      !Buffer.isBuffer(req.body) ||
      req.body.length === 0 ||
      !contentMatchesType(req.body, mime)
    )
      throw badRequest('Image PNG, JPEG, WebP ou GIF attendue (500 Ko au plus).');
    const name = headerFileName(req.headers['x-file-name'], 'image').slice(0, 120);
    return db.transaction(async (tx) => {
      const [a] = await tx
        .insert(emailAsset)
        .values({ name, mime, bytes: req.body as Buffer, createdBy: req.user!.id })
        .returning({ id: emailAsset.id });
      await audit(tx, req, {
        action: 'email_asset.upload',
        entity: 'email_asset',
        entityId: a!.id,
        after: { name, mime, bytes: (req.body as Buffer).length },
      });
      return { id: a!.id, name, mime, bytes: (req.body as Buffer).length };
    });
  });

  app.get('/email-assets/:id', { ...admin, schema: { params: idParams } }, async (req, reply) => {
    const [a] = await db.select().from(emailAsset).where(eq(emailAsset.id, req.params.id));
    if (!a) throw notFound('Image introuvable.');
    return reply
      .header('cache-control', 'private, max-age=86400, immutable')
      .type(a.mime)
      .send(a.bytes);
  });

  app.delete(
    '/email-assets/:id',
    { ...admin, schema: { params: idParams } },
    async (req, reply) => {
      const used = (await usage()).get(req.params.id);
      if (used?.length)
        throw conflict(`Cette image est utilisée (${used.join(', ')}) : remplacez-la d’abord.`);
      await db.transaction(async (tx) => {
        const [a] = await tx
          .delete(emailAsset)
          .where(eq(emailAsset.id, req.params.id))
          .returning({ id: emailAsset.id, name: emailAsset.name });
        if (!a) throw notFound('Image introuvable.');
        await audit(tx, req, {
          action: 'email_asset.delete',
          entity: 'email_asset',
          entityId: a.id,
          before: { name: a.name },
        });
      });
      return reply.status(204).send();
    },
  );
};
