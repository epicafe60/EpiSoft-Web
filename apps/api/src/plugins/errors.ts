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
      template: 'alert_server_error',
      values: {
        page: e.route,
        reference: e.ref,
        message: e.message.slice(0, 200),
        nombre: String(row?.count ?? 1),
      },
    },
    { title: 'Erreur du serveur', body: `Référence ${e.ref}`, url: '/surveillance/erreurs' },
    log,
  );
}

/** The start of the message of a refused entry in the error log (Surveillance › Erreurs). */
export const REFUSAL_PREFIX = 'Saisie refusée';

/**
 * A form refused by the validation is remembered, grouped by route and by the fields at fault:
 * « Saisie refusée : salePrice, eans » on POST /products, ×12. Only names of fields, never their
 * values. It lets an administrator see which form blocks people without asking them for a
 * screenshot. No e-mail, and it does not count in « À surveiller » (it is not a breakdown).
 */
async function recordRefusal(
  db: Db,
  e: { route: string; fields: string[]; memberId: string | null },
) {
  const message = `${REFUSAL_PREFIX} : ${[...new Set(e.fields)].sort().join(', ') || '(corps de la requête)'}`;
  const fingerprint = createHash('sha1').update(`${e.route}|${message}`).digest('hex');
  await db
    .insert(errorLog)
    .values({
      fingerprint,
      message: message.slice(0, 500),
      route: e.route,
      lastRef: 'SAISIE',
      lastMemberId: e.memberId,
    })
    .onConflictDoUpdate({
      target: errorLog.fingerprint,
      set: { count: sql`${errorLog.count} + 1`, lastAt: new Date(), lastMemberId: e.memberId },
    });
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
        ...(err.code ? { code: err.code } : {}),
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
      if (opts.db && req.user)
        void recordRefusal(opts.db, {
          route: `${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`,
          fields: (problem.errors ?? []).map((x) => x.path.split('.')[0] ?? ''),
          memberId: req.user.id,
        }).catch((e) => req.log.error({ err: e }, 'refus de saisie non enregistré'));
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
