import Fastify, { type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from '@episoft/db';
import type { Config } from './config';
import { audit } from './lib/audit';
import auth from './plugins/auth';
import errors from './plugins/errors';
import { authRoutes } from './modules/auth/routes';
import { adminRoutes } from './modules/admin/routes';
import { posRoutes } from './modules/pos/routes';
import { memberRoutes } from './modules/members/routes';
import { catalogRoutes } from './modules/catalog/routes';
import { walletRoutes } from './modules/members/wallet-routes';
import { supplierRoutes } from './modules/supplies/suppliers';
import { orderRoutes } from './modules/supplies/orders';
import { invoiceRoutes } from './modules/supplies/invoices';
import { stockRoutes } from './modules/stock/routes';
import { catalogAdminRoutes } from './modules/catalog/admin';
import { accountingRoutes } from './modules/accounting/routes';
import { bankRoutes } from './modules/accounting/bank';
import { closingRoutes } from './modules/accounting/closing';
import { pushRoutes } from './modules/push/routes';
import { budgetRoutes } from './modules/accounting/budget';
import { proposalRoutes } from './modules/accounting/proposals';
import { reportRoutes } from './modules/accounting/reports';
import { dashboardRoutes } from './modules/stats/dashboard';
import { analysisRoutes } from './modules/stats/analysis';
import { exportRoutes } from './modules/stats/export';
import { savedReportRoutes } from './modules/stats/saved-reports';
import { importRoutes } from './modules/stats/imports';
import { integrityRoutes } from './modules/admin/integrity';
import { monitoringRoutes } from './modules/admin/monitoring';
import { walletReportRoutes } from './modules/admin/wallet-report';
import { selfRoutes } from './modules/members/self';
import { reviewRoutes } from './modules/preorders/reviews';
import { favoriteRoutes } from './modules/preorders/favorites';
import { seriesRoutes } from './modules/stats/series';
import { preorderRoutes } from './modules/preorders/routes';
import { revertRoutes } from './modules/admin/revert/routes';

export async function buildApp(db: Db, config: Config, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    // Behind Caddy in production: trust it for the client IP (R-AUTH-07).
    trustProxy: config.NODE_ENV === 'production' ? 'loopback,uniquelocal' : false,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errors, { db, config });
  await app.register(helmet, {
    // The SPA is served from the same origin; inline styles are needed by some UI components.
    contentSecurityPolicy: {
      directives: {
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
      },
    },
    hsts: config.COOKIE_SECURE,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // OpenAPI description generated from the Zod schemas (spec §8.1). Browsable outside production.
  await app.register(swagger, {
    openapi: { info: { title: 'EpiSoft API', version: '1' }, servers: [{ url: '/' }] },
    transform: jsonSchemaTransform,
  });
  if (config.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }
  await app.register(auth, { db, config });

  // R-ADM-05: every file handed out (Excel, PDF, JSON) is recorded, unless the route already
  // recorded what it gave (e.g. « a exporté la liste des adhérents »).
  app.addHook('onSend', async (req, reply, payload) => {
    const disposition = reply.getHeader('content-disposition');
    if (typeof disposition !== 'string' || reply.statusCode >= 300 || req.audited || !req.user)
      return payload;
    const file = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
    await audit(db, req, {
      action: 'export.file',
      entity: 'file',
      after: { file, url: req.url.split('?')[0] },
    });
    return payload;
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { db, config });
      await api.register(adminRoutes, { db, config });
      await api.register(posRoutes, { db, config });
      await api.register(memberRoutes, { db, config });
      await api.register(catalogRoutes, { db, config });
      await api.register(walletRoutes, { db, config });
      await api.register(supplierRoutes, { db, config });
      await api.register(orderRoutes, { db, config });
      await api.register(invoiceRoutes, { db, config });
      await api.register(stockRoutes, { db, config });
      await api.register(catalogAdminRoutes, { db, config });
      await api.register(accountingRoutes, { db, config });
      await api.register(bankRoutes, { db, config });
      await api.register(reportRoutes, { db, config });
      await api.register(budgetRoutes, { db, config });
      await api.register(proposalRoutes, { db, config });
      await api.register(closingRoutes, { db, config });
      await api.register(dashboardRoutes, { db, config });
      await api.register(analysisRoutes, { db, config });
      await api.register(exportRoutes, { db, config });
      await api.register(savedReportRoutes, { db, config });
      await api.register(importRoutes, { db, config });
      await api.register(integrityRoutes, { db, config });
      await api.register(walletReportRoutes, { db, config });
      await api.register(monitoringRoutes, { db, config });
      await api.register(selfRoutes, { db, config });
      await api.register(reviewRoutes, { db, config });
      await api.register(favoriteRoutes, { db, config });
      await api.register(seriesRoutes, { db, config });
      await api.register(preorderRoutes, { db, config });
      await api.register(pushRoutes, { db, config });
      await api.register(revertRoutes, { db, config });
    },
    { prefix: '/api/v1' },
  );

  // Production: the API also serves the built web app, with a SPA fallback (spec §7.3).
  if (config.WEB_DIST) {
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });
    app.get('/*', { config: { public: true } }, (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.callNotFound();
      return reply.sendFile('index.html');
    });
  }

  return app;
}
