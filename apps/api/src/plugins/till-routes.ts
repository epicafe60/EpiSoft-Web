/**
 * R-SES-07: the routes the till uses. While another cashier keeps the till with a session, these
 * only answer it: everything else of the holder's rights (members, accounting, administration…)
 * answers 403 TILL_LOCKED until the holder types their password again. Kept in one list, checked
 * by test/route-access.test.ts.
 */
export const TILL_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/me',
  'POST /api/v1/auth/unlock',
  'GET /api/v1/controls/thresholds',
  'GET /api/v1/membership-types',
  'GET /api/v1/media/:id',
  'GET /api/v1/pos/devices',
  'POST /api/v1/pos/devices',
  'GET /api/v1/pos/devices/:id/state',
  'GET /api/v1/sync/snapshot',
  'POST /api/v1/sync/push',
  'POST /api/v1/pos/cashier',
  'PUT /api/v1/pos/cashiers/:id/pin',
  'GET /api/v1/pos/connected',
  'GET /api/v1/pos/sessions',
  'GET /api/v1/pos/sessions/:id/presence',
  'GET /api/v1/pos/sessions/:id/summary',
  'POST /api/v1/pos/sessions/:id/close',
  'GET /api/v1/pos/sessions/:id/report',
  'GET /api/v1/pos/sessions/:id/report.pdf',
  'GET /api/v1/pos/sales',
  'GET /api/v1/pos/sales/:id',
  'POST /api/v1/pos/sales/:id/email',
  'GET /api/v1/preorders',
  'GET /api/v1/preorders/:id',
]);
