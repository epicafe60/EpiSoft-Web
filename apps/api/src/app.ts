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

export async function buildApp(db: Db, config: Config, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    // Behind Caddy in production: trust it for the client IP (R-AUTH-07).
    trustProxy: config.NODE_ENV === 'production' ? 'loopback,uniquelocal' : false,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errors);
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
