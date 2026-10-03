import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { FastifyError } from 'fastify';
import type { Problem } from '@episoft/shared';
import { HttpProblem } from '../lib/problem';

// Every error leaves the API as application/problem+json (spec §8.1).
export default fp(async (app) => {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    let problem: Problem;
    if (err instanceof HttpProblem) {
      problem = {
        type: 'about:blank',
        title: err.title,
        status: err.status,
        detail: err.detail,
        errors: err.errors,
      };
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      problem = {
        type: 'about:blank',
        title: 'Requête invalide',
        status: 400,
        detail: 'Certaines valeurs sont invalides.',
        errors: err.validation.map((v) => ({
          path: v.instancePath.replace(/^\//, '').replace(/\//g, '.'),
          message: v.message ?? 'Valeur invalide.',
        })),
      };
    } else if (err.statusCode && err.statusCode < 500) {
      problem = {
        type: 'about:blank',
        title: err.statusCode === 429 ? 'Trop de requêtes' : 'Requête refusée',
        status: err.statusCode,
        detail: err.message,
      };
    } else {
      req.log.error({ err }, 'erreur interne');
      problem = {
        type: 'about:blank',
        title: 'Erreur interne',
        status: 500,
        detail: 'Une erreur inattendue est survenue.',
      };
    }
    void reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: 'Introuvable',
        status: 404,
        detail: `${req.method} ${req.url}`,
      } satisfies Problem);
  });
});
