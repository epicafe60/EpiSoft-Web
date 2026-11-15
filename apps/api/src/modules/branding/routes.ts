import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { emailAsset, type Db } from '@episoft/db';
import { brandingLogoUrl, type BrandingInfo } from '@episoft/shared';
import type { Config } from '../../config';
import { notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';

/**
 * What the application shows of itself before anyone is signed in: its name, its logo, its colour,
 * and the manifest of the installed app. Public, and it serves one image only: the one chosen as
 * the logo (the rest of the library stays private).
 */
export const brandingRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const open = { config: { public: true } };

  const read = async (): Promise<BrandingInfo> => {
    const settings = await loadSettings(db);
    const b = settings['app.branding'];
    return {
      appName: b.appName,
      shortName: b.shortName,
      associationName: settings['association.identity'].name,
      accentColor: b.accentColor,
      logoUrl: brandingLogoUrl(b.logoImageId),
      customLogo: !!b.logoImageId,
    };
  };

  app.get('/branding', open, async (_req, reply): Promise<BrandingInfo> => {
    reply.header('cache-control', 'no-cache');
    return read();
  });

  app.get(
    '/branding/logo/:id',
    { ...open, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const chosen = (await loadSettings(db))['app.branding'].logoImageId;
      if (!chosen || chosen !== req.params.id) throw notFound('Image introuvable.');
      const [img] = await db.select().from(emailAsset).where(eq(emailAsset.id, chosen));
      if (!img) throw notFound('Image introuvable.');
      return reply
        .header('cache-control', 'public, max-age=86400, immutable')
        .type(img.mime)
        .send(img.bytes);
    },
  );

  /** The manifest of the installed app (name, colour, icon): written from the settings. */
  app.get('/branding/manifest.webmanifest', open, async (_req, reply) => {
    const settings = await loadSettings(db);
    const b = settings['app.branding'];
    let icons: { src: string; sizes: string; type: string; purpose: string }[] = [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ];
    if (b.logoImageId) {
      const [img] = await db
        .select({ mime: emailAsset.mime })
        .from(emailAsset)
        .where(eq(emailAsset.id, b.logoImageId));
      if (img)
        icons = [
          { src: brandingLogoUrl(b.logoImageId), sizes: 'any', type: img.mime, purpose: 'any' },
        ];
    }
    return reply
      .header('cache-control', 'no-cache')
      .type('application/manifest+json')
      .send({
        name: `${b.appName} — ${settings['association.identity'].name}`,
        short_name: b.appName,
        lang: 'fr',
        start_url: '/caisse',
        display: 'standalone',
        theme_color: b.accentColor,
        background_color: '#fbfaf5',
        icons,
      });
  });
};
