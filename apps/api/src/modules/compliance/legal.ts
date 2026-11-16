import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { setting, type Db } from '@episoft/db';
import {
  buildLegalPages,
  CONSENT_PURPOSES,
  CONSENTS,
  PROCESSING_REGISTER,
  type LegalPages,
} from '@episoft/shared';
import type { Config } from '../../config';
import { loadSettings } from '../admin/settings-store';

/**
 * The two public pages (mentions légales, politique de confidentialité), written from the identity
 * of the association and the texts an administrator keeps in the settings; and the register of
 * processing (art. 30 RGPD) for the administrators.
 */
export const legalRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  app.get('/legal', { config: { public: true } }, async (_req, reply) => {
    const settings = await loadSettings(db);
    const [row] = await db.select().from(setting).where(eq(setting.key, 'legal.texts'));
    const pages: LegalPages = buildLegalPages(
      settings['association.identity'],
      settings['legal.texts'],
    );
    reply.header('cache-control', 'no-cache');
    return {
      associationName: settings['association.identity'].name,
      mentions: pages.mentions,
      privacy: pages.privacy,
      // The gaps are for the administrators, who see them in the settings; the public does not.
      updatedAt: row?.updatedAt.toISOString() ?? null,
      consents: CONSENT_PURPOSES.map((p) => ({
        purpose: p,
        label: CONSENTS[p].label,
        basis: CONSENTS[p].basis,
      })),
    };
  });

  /** What is still missing on the public pages (administrators). */
  app.get('/admin/legal/gaps', { preHandler: app.requireRoles('ADMIN') }, async () => {
    const settings = await loadSettings(db);
    return buildLegalPages(settings['association.identity'], settings['legal.texts']).gaps;
  });

  /**
   * The register of processing, generated from the list kept next to the code (with the tables
   * that hold each processing and how many rows they hold today). The retention shown is the
   * reference of the code; the configurable policy will replace it.
   */
  app.get('/admin/processing-register', { preHandler: app.requireRoles('ADMIN') }, async () => {
    const out = [];
    for (const a of PROCESSING_REGISTER) {
      const tables = [];
      for (const t of a.tables) {
        const [r] = (
          await db.execute(sql`select count(*)::int as n from app.${sql.identifier(t)}`)
        ).rows as { n: number }[];
        tables.push({ table: t, rows: r!.n });
      }
      out.push({ ...a, tables });
    }
    return out;
  });
};
