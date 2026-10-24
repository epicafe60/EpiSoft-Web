import { createHash, randomBytes } from 'node:crypto';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { FastifyBaseLogger, FastifyError } from 'fastify';
import { errorLog, type Db } from '@episoft/db';
import { sql } from 'drizzle-orm';
import type { Problem } from '@episoft/shared';
import type { Config } from '../config';
import { alertNow } from '../lib/alerts';
import { HttpProblem } from '../lib/problem';

/**
 * What may be kept and e-mailed about an error: never the SQL nor its parameters (a database
 * error carries them in its message: e-mail addresses, password hashes, amounts). For such an
 * error the message of its cause is used (« violates foreign key constraint … »).
 */
export function safeErrorMessage(err: { message?: string; cause?: unknown }): string {
  const cause = err.cause as { message?: unknown } | undefined;
  let text =
    typeof cause?.message === 'string' && cause.message ? cause.message : (err.message ?? '');
  if (/^Failed query:/i.test(text)) text = 'Requête refusée par la base de données';
  text = text.split(/\n\s*params:/i)[0]!.split('\n')[0]!;
  return text.slice(0, 300);
}

/**
 * Remembers an unexpected error (grouped by fingerprint) and tells the responsables, at most once
 * an hour for the same error. Never throws: the user already has an answer.
 */
async function recordServerError(
  db: Db,
  config: Config,
  e: { message: string; route: string; ref: string; memberId: string | null },
  log: FastifyBaseLogger,
) {
  const firstLine = e.message.split('\n')[0];
  const fingerprint = createHash('sha1').update(`${e.route}|${firstLine}`).digest('hex');
  const [row] = await db
    .insert(errorLog)
    .values({
      fingerprint,
      message: e.message.slice(0, 500),
      route: e.route,
      lastRef: e.ref,
      lastMemberId: e.memberId,
    })
    .onConflictDoUpdate({
      target: errorLog.fingerprint,
      set: {
        count: sql`${errorLog.count} + 1`,
        lastAt: new Date(),
        lastRef: e.ref,
        lastMemberId: e.memberId,
        acknowledgedAt: null,
      },
    })
    .returning({ count: errorLog.count });
  await alertNow(
    db,
    config,
    ['ADMIN'],
    {
      subject: 'Épicafé : une erreur inattendue est survenue',
      lines: [
        `Page : ${e.route}`,
        `Référence donnée à l’utilisateur : ${e.ref}`,
        `Message : ${e.message.slice(0, 200)}`,
        `Nombre de fois (même erreur) : ${row?.count ?? 1}`,
        'Détails dans Surveillance › Erreurs du serveur.',
      ],
    },
    { title: 'Erreur du serveur', body: `Référence ${e.ref}`, url: '/surveillance/erreurs' },
    log,
  );
}

// Every error leaves the API as application/problem+json (spec §8.1).
export default fp<{ db?: Db; config?: Config }>(async (app, opts) => {
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
      // A reference the user can read out: it finds this error in Surveillance › Erreurs.
      const ref = randomBytes(3).toString('hex').toUpperCase();
      req.log.error({ err, ref }, 'erreur interne');
      if (opts.db && opts.config)
        void recordServerError(
          opts.db,
          opts.config,
          {
            message: safeErrorMessage(err),
            route: `${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`,
            ref,
            memberId: req.user?.id ?? null,
          },
          req.log,
        ).catch((e) => req.log.error({ err: e }, 'erreur non enregistrée'));
      problem = {
        type: 'about:blank',
        title: 'Erreur interne',
        status: 500,
        detail: `Un problème est survenu de notre côté. Référence ${ref} : donnez-la à l’administrateur.`,
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
