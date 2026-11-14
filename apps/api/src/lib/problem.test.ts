import { describe, expect, it } from 'vitest';
import { badRequest, conflict, forbidden, HttpProblem, notFound, unauthorized } from './problem';

describe('problem helpers (spec §8.1)', () => {
  it('each helper has the right status and a French title', () => {
    expect(
      [badRequest('x'), unauthorized(), forbidden(), notFound(), conflict('x')].map(
        (p) => p.status,
      ),
    ).toEqual([400, 401, 403, 404, 409]);
    expect(forbidden().title).toBe('Accès refusé');
    expect(conflict('Code utilisé.').detail).toBe('Code utilisé.');
  });
  it('the message of the error is its detail, or its title', () => {
    expect(new HttpProblem(400, 'Titre', 'Détail').message).toBe('Détail');
    expect(new HttpProblem(400, 'Titre').message).toBe('Titre');
  });
  it('a bad request can carry the fields at fault', () => {
    const p = badRequest('Certaines valeurs sont invalides.', [
      { path: 'name', message: 'Nom requis.' },
    ]);
    expect(p.errors).toEqual([{ path: 'name', message: 'Nom requis.' }]);
  });
});
