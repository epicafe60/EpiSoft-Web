import { expect, test } from '@playwright/test';

// Audit KV2, S01, through the whole stack (web server in front of the API), not only the API
// alone: a path written with an encoded letter must not get past the protections.

const isJson = (r: { headers(): Record<string, string> }) =>
  (r.headers()['content-type'] ?? '').includes('json');

test('without a session, the API answers 401 on its plain path', async ({ request }) => {
  const r = await request.get('/api/v1/me');
  expect(r.status()).toBe(401);
  expect(isJson(r)).toBe(true);
});

test('without a session, an encoded API path gives no data', async ({ request }) => {
  for (const path of [
    '/%61pi/v1/me',
    '/%61pi/v1/admin/users',
    '/a%70i/v1/communes',
    '/%2561pi/v1/me',
  ]) {
    const r = await request.get(path);
    // Either refused, or not the API at all (the application page): never JSON data.
    expect(r.status() === 200 && isJson(r), path).toBe(false);
    expect(await r.text(), path).not.toMatch(/"username"|"roles"|"postcode"/);
  }
});

test('an encoded path does not skip the anti-CSRF header', async ({ request }) => {
  const r = await request.post('/%61pi/v1/auth/logout');
  expect(r.status()).not.toBe(204);
});
