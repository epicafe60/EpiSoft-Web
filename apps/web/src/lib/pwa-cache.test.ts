import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Audit KV2, S03: the service worker keeps product images only. A private document (an invoice
// attachment) must never land in the cache that survives a sign-out.

const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');

describe('S03 — what the service worker caches', () => {
  it('runtime caching concerns the product images route and nothing else', () => {
    const patterns = [...config.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)].map(
      (m) => m[1],
    );
    expect(patterns).toEqual(['/api/v1/media/']);
    expect(config).not.toMatch(/invoices|factures|document/i);
  });
  it('the application shell never caches an API answer', () => {
    expect(config).toMatch(/navigateFallbackDenylist:\s*\[[^\]]*api/);
  });
});
