import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pdfTemplate, type Db } from '@episoft/db';
import {
  PDF_DOC_KEYS,
  PDF_TEMPLATES,
  defaultPdfConfig,
  pdfTemplateDef,
  pdfTemplateProblems,
  pdfTemplateSaveSchema,
  type PdfTemplateConfig,
  type PdfTemplateDetail,
  type PdfTemplateRow,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { loadHeaderLogo } from '../../lib/email-render';
import { badRequest } from '../../lib/problem';
import { sanitizePdfHtml } from '../../lib/pdf-html';
import { previewPdf } from '../../lib/pdf-preview';
import { loadPdfConfig } from '../../lib/pdf-template';

const keyParams = z.object({ key: z.enum(PDF_DOC_KEYS) });

/** Cleans what the editor sends: the HTML of the zones is reduced to what a PDF can draw. */
function cleaned(config: PdfTemplateConfig): PdfTemplateConfig {
  return {
    ...config,
    zones: Object.fromEntries(
      Object.entries(config.zones).map(([k, v]) => [k, sanitizePdfHtml(v)]),
    ),
  };
}

/**
 * The PDF documents of the application, edited by the administrators: the text zones (header, notes,
 * footer, with variables), the columns of the table and the labels. What is saved is cleaned and
 * checked against the variables and the columns the document knows; deleting a template puts the
 * original back. Same shape as the e-mails (email-templates.ts).
 */
export const pdfTemplateRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const admin = { preHandler: app.requireRoles('ADMIN') };

  const detail = async (key: PdfTemplateDetail['key']): Promise<PdfTemplateDetail> => {
    const def = pdfTemplateDef(key)!;
    const loaded = await loadPdfConfig(db, key);
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      customized: loaded.customized,
      updatedAt: loaded.updatedAt?.toISOString() ?? null,
      config: loaded.config,
      defaults: defaultPdfConfig(def),
      variables: def.variables,
      zones: def.zones,
      columns: def.columns,
      labels: def.labels,
      logo: def.logo,
    };
  };

  app.get('/pdf-templates', admin, async (): Promise<PdfTemplateRow[]> => {
    const rows = await db.select().from(pdfTemplate);
    return PDF_TEMPLATES.map((d) => {
      const row = rows.find((r) => r.key === d.key);
      return {
        key: d.key,
        label: d.label,
        description: d.description,
        customized: !!row,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  });

  app.get('/pdf-templates/:key', { ...admin, schema: { params: keyParams } }, async (req) =>
    detail(req.params.key),
  );

  app.put(
    '/pdf-templates/:key',
    { ...admin, schema: { params: keyParams, body: pdfTemplateSaveSchema } },
    async (req) => {
      const def = pdfTemplateDef(req.params.key)!;
      const config = cleaned(req.body);
      const problems = pdfTemplateProblems(def, config);
      if (problems.length)
        throw badRequest(
          problems[0]!,
          problems.map((message) => ({ path: 'config', message })),
        );
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ config: pdfTemplate.config })
          .from(pdfTemplate)
          .where(eq(pdfTemplate.key, def.key))
          .for('update');
        await tx
          .insert(pdfTemplate)
          .values({ key: def.key, config, updatedBy: req.user!.id })
          .onConflictDoUpdate({
            target: pdfTemplate.key,
            set: { config, updatedBy: req.user!.id, updatedAt: new Date() },
          });
        await audit(tx, req, {
          action: 'pdf_template.update',
          entity: 'pdf_template',
          entityId: def.key,
          before: before ? { columns: columnKeys(before.config) } : null,
          after: { label: def.label, columns: config.columns.map((c) => c.key) },
        });
      });
      return detail(req.params.key);
    },
  );

  /** Puts the wording and the columns of the application back. */
  app.delete(
    '/pdf-templates/:key',
    { ...admin, schema: { params: keyParams } },
    async (req, reply) => {
      const def = pdfTemplateDef(req.params.key)!;
      await db.transaction(async (tx) => {
        const [gone] = await tx
          .delete(pdfTemplate)
          .where(eq(pdfTemplate.key, def.key))
          .returning({ config: pdfTemplate.config });
        if (!gone) return;
        await audit(tx, req, {
          action: 'pdf_template.reset',
          entity: 'pdf_template',
          entityId: def.key,
          before: { columns: columnKeys(gone.config) },
          after: { label: def.label },
        });
      });
      return reply.status(204).send();
    },
  );

  /** The document with the draft being edited (or the saved template), filled with samples. */
  app.post(
    '/pdf-templates/:key/preview',
    {
      ...admin,
      schema: { params: keyParams, body: z.object({ config: pdfTemplateSaveSchema.optional() }) },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const def = pdfTemplateDef(req.params.key)!;
      const config = req.body.config
        ? cleaned(req.body.config)
        : (await loadPdfConfig(db, def.key)).config;
      const problems = pdfTemplateProblems(def, config);
      if (problems.length)
        throw badRequest(
          problems[0]!,
          problems.map((message) => ({ path: 'config', message })),
        );
      const pdf = await previewPdf(db, def.key, config, await loadHeaderLogo(db));
      return reply
        .header('content-disposition', `inline; filename="${def.key}-apercu.pdf"`)
        .header('cache-control', 'no-store')
        .type('application/pdf')
        .send(pdf);
    },
  );
};

const columnKeys = (config: unknown): string[] => {
  const columns = (config as { columns?: { key?: string }[] } | null)?.columns;
  return Array.isArray(columns) ? columns.flatMap((c) => (c.key ? [c.key] : [])) : [];
};
