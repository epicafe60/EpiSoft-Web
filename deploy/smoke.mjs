#!/usr/bin/env node
// After-deployment check: does the application answer, and are the protections of the audit
// KV2 (S01 and others) still in place behind the real proxy? Run on the server or from anywhere:
//
//   node deploy/smoke.mjs https://epicafe.ddns.net        (exit 1 and the list of failures)
//
// Needs only Node 22 (the server has no curl). Nothing is written: reads, and two refused writes.

/**
 * @param {string} base  address of the application, without a trailing slash
 * @param {{ https?: boolean, fetchImpl?: typeof fetch, skip?: string[] }} [opts]  `skip`: names of checks that do not apply here (the documentation is on outside production)
 * @returns {Promise<{ name: string, ok: boolean, detail: string }[]>}
 */
export async function runSmoke(base, opts = {}) {
  const get = opts.fetchImpl ?? fetch;
  const https = opts.https ?? base.startsWith('https:');
  const results = [];
  const check = async (name, fn) => {
    if (opts.skip?.includes(name)) return;
    try {
      const detail = await fn();
      results.push({ name, ok: detail === true || detail === undefined, detail: String(detail) });
    } catch (e) {
      results.push({ name, ok: false, detail: String(e) });
    }
  };
  const call = (path, init = {}) => get(base + path, { redirect: 'manual', ...init });
  const isJson = (r) => (r.headers.get('content-type') ?? '').includes('json');
  const expect = (cond, detail) => (cond ? true : detail);

  await check('the application answers: /api/v1/health is 200', async () => {
    const r = await call('/api/v1/health');
    return expect(r.status === 200, `status ${r.status}`);
  });
  await check('without a session, the API answers 401 (deny by default)', async () => {
    const r = await call('/api/v1/me');
    return expect(r.status === 401, `status ${r.status}`);
  });
  await check('an encoded path gives no data (S01)', async () => {
    for (const path of ['/%61pi/v1/me', '/%61pi/v1/members', '/a%70i/v1/communes']) {
      const r = await call(path);
      const body = await r.text();
      if (r.status === 200 && isJson(r)) return `${path} answered JSON data`;
      if (/"username"|"roles"|"postcode"|"lastName"/.test(body)) return `${path} leaked data`;
    }
    return true;
  });
  await check('an encoded write does not skip the anti-CSRF header (S01)', async () => {
    const r = await call('/%61pi/v1/auth/logout', { method: 'POST' });
    return expect(r.status !== 204, `status ${r.status}`);
  });
  await check('a write without the anti-CSRF header is refused', async () => {
    const r = await call('/api/v1/auth/logout', { method: 'POST' });
    return expect(r.status === 403, `status ${r.status}`);
  });
  await check('the interactive API documentation is not exposed', async () => {
    const r = await call('/docs/');
    const body = await r.text();
    return expect(!/swagger-ui/i.test(body), 'the documentation answers');
  });
  await check('security headers are present', async () => {
    const r = await call('/api/v1/health');
    const missing = ['x-content-type-options', 'content-security-policy'].filter(
      (h) => !r.headers.get(h),
    );
    if (https && !r.headers.get('strict-transport-security'))
      missing.push('strict-transport-security');
    return expect(!missing.length, `missing: ${missing.join(', ')}`);
  });
  await check('a protected file cannot be fetched without a session (C05)', async () => {
    const r = await call('/api/v1/media/0190a0a0-0000-7000-8000-000000000001');
    return expect(r.status === 401, `status ${r.status}`);
  });
  return results;
}

// Command line.
const entry = process.argv[1] ?? '';
if (import.meta.url.endsWith(entry.replace(/\\/g, '/').split('/').pop() ?? '') && process.argv[2]) {
  const base = process.argv[2].replace(/\/$/, '');
  const results = await runSmoke(base);
  for (const r of results)
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed.length ? 1 : 0);
}
