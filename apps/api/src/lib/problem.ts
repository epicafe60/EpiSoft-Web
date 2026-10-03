import type { Problem } from '@episoft/shared';

/** An error rendered as application/problem+json (spec §8.1). */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: Problem['errors'],
  ) {
    super(detail ?? title);
  }
}

export const badRequest = (detail: string, errors?: Problem['errors']) =>
  new HttpProblem(400, 'Requête invalide', detail, errors);
export const unauthorized = (detail = 'Vous devez être connecté.') =>
  new HttpProblem(401, 'Non authentifié', detail);
export const forbidden = (detail = 'Vous n’avez pas les droits nécessaires.') =>
  new HttpProblem(403, 'Accès refusé', detail);
export const notFound = (detail = 'Élément introuvable.') =>
  new HttpProblem(404, 'Introuvable', detail);
export const conflict = (detail: string) => new HttpProblem(409, 'Conflit', detail);
