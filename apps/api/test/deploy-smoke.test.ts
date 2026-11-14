import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain Node script, shared with the server (it has no curl)
import { runSmoke } from '../../../deploy/smoke.mjs';
import { setupTestApp } from './helpers';

// The after-deployment check (deploy/smoke.mjs) passes on a healthy application, and is able to
// tell when a protection is gone. Run against a real listening server, as it is on the machine.

let t: Awaited<ReturnType<typeof setupTestApp>>;
let base: string;
beforeAll(async () => {
  t = await setupTestApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => t.close());

const DOCS = 'the interactive API documentation is not exposed'; // on outside production

describe('deploy/smoke.mjs', () => {
  it('passes on a healthy application', async () => {
    const results = await runSmoke(base, { https: false, skip: [DOCS] });
    expect(results.length).toBeGreaterThanOrEqual(7);
    expect(results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
  });

  it('fails when the application is down or a protection is missing', async () => {
    const down = await runSmoke('http://127.0.0.1:9', { https: false, skip: [DOCS] });
    expect(down.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    // A proxy in front that answers 200 JSON on an encoded path (a protection gone).
    const leaking = (async (url: string, init?: RequestInit) =>
      url.includes('%61pi')
        ? new Response('{"username":"a"}', { headers: { 'content-type': 'application/json' } })
        : fetch(url, init)) as typeof fetch;
    const r = await runSmoke(base, { https: false, skip: [DOCS], fetchImpl: leaking });
    expect(r.find((x: { name: string }) => x.name.includes('encoded path'))?.ok).toBe(false);
  });
});
