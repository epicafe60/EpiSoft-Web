import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TILL_ROUTES } from '../src/plugins/till-routes';
import { setupTestApp } from './helpers';

// Who may call each route (R-AUTH-06, audit KV2). A route is either public, guarded by roles
// (requireRoles), or listed here as open to any signed-in member, with the check it makes itself.
// A new route that is none of these makes this test fail: decide who may call it.

const PUBLIC = [
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'GET /api/v1/health',
  'POST /api/v1/internal/backup-report', // shared secret, compared in constant time
];

/** Open to any signed-in member: what each one checks by itself. */
const ANY_MEMBER: Record<string, string> = {
  'POST /api/v1/auth/impersonate/stop': 'ends the impersonation of the session itself',
  'POST /api/v1/auth/unlock': 'the password of the session holder (R-SES-07)',
  'GET /api/v1/communes': 'reference list (postcodes, towns)',
  'GET /api/v1/controls/thresholds': 'thresholds of the till checks, no personal data',
  'POST /api/v1/imports/:kind/preview': 'role checked per kind (PRODUITS or ADHERENTS)',
  'POST /api/v1/imports/:kind/apply': 'role checked per kind (PRODUITS or ADHERENTS)',
  'GET /api/v1/imports/history': 'PRODUITS or ADHERENTS checked in the handler',
  'GET /api/v1/me': 'the signed-in member',
  'GET /api/v1/me/export': 'the signed-in member',
  'GET /api/v1/me/household': 'the household of the signed-in member',
  'GET /api/v1/me/tickets/:id': 'only a ticket of the household of the signed-in member',
  'GET /api/v1/media/:id': 'only images of products (C05)',
  'GET /api/v1/membership-types': 'reference list',
  'POST /api/v1/preorders': 'for oneself; for another member with an orders role',
  'GET /api/v1/preorders/:id': 'own pre-order, or an orders or till role',
  'POST /api/v1/preorders/:id/status': 'own cancellation, or COMMANDES_GESTION',
  'GET /api/v1/preorders/mine': 'the signed-in member',
  'GET /api/v1/push/key': 'public key of the server',
  'POST /api/v1/push/subscribe': 'own devices; push services only (S07)',
  'POST /api/v1/push/unsubscribe': 'own devices',
  'GET /api/v1/shop/favorites': 'own favorites',
  'PUT /api/v1/shop/favorites/:id': 'own favorites',
  'DELETE /api/v1/shop/favorites/:id': 'own favorites',
  'GET /api/v1/shop/products': 'the shop window',
  'GET /api/v1/shop/ratings': 'the shop window',
  'GET /api/v1/shop/products/:id/reviews': 'approved reviews, and own review',
  'PUT /api/v1/shop/products/:id/review': 'own review',
  'GET /api/v1/stats/dashboard': 'each block only for the roles that use it',
};

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

describe('the access of every route is decided', () => {
  it('is public, guarded by roles, or listed as open to any signed-in member', () => {
    const routes = t.app.routeAccess;
    expect(routes.length).toBeGreaterThan(200);
    const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
    const unguarded = routes
      .filter((r) => !r.roles && !r.public)
      .map(key)
      .sort();
    expect(unguarded).toEqual(Object.keys(ANY_MEMBER).sort());
    expect(
      routes
        .filter((r) => r.public)
        .map(key)
        .sort(),
    ).toEqual([...PUBLIC].sort());
  });

  it('names exactly the routes the till keeps while another cashier holds it (R-SES-07)', () => {
    const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
    const marked = t.app.routeAccess
      .filter((r) => r.till)
      .map(key)
      .sort();
    // Every name of the list is a real route, and nothing else is marked.
    expect(marked).toEqual([...TILL_ROUTES].sort());
    // None of them is an administration route of the holder's rights.
    const adminLike = /\/(admin|accounting|entries|members|households)(\/|$)/;
    expect(marked.filter((k) => adminLike.test(k))).toEqual([]);
  });
});
