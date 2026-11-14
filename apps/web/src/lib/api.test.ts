import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@episoft/shared';
import { api, ApiError } from './api';

// The client of the API: what the forms rely on to show a refusal under the right field.

const reply = (status: number, body: unknown, statusText = '') =>
  vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      statusText,
      headers: { 'content-type': 'application/json' },
    }),
  );

afterEach(() => vi.unstubAllGlobals());

const fail = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('the call should have failed');
    },
    (e: ApiError) => e,
  );

describe('postForFile', () => {
  it('sends the body with the anti-CSRF header and returns the file with its name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('contenu', {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="Membres-2026-11-14.xlsx"' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await api.postForFile('/exports/table', { scope: 'membres' });
    expect(out.filename).toBe('Membres-2026-11-14.xlsx');
    expect(await out.blob.text()).toBe('contenu');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/exports/table');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('1');
    expect(init.body).toBe(JSON.stringify({ scope: 'membres' }));
  });

  it('says why the server refused, as the other calls do', async () => {
    vi.stubGlobal(
      'fetch',
      reply(403, { type: 'about:blank', title: 'Interdit', status: 403, detail: 'Réservé.' }),
    );
    const e = await fail(api.postForFile('/exports/table', {}));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(403);
    expect(e.message).toBe('Réservé.');
  });

  it('says clearly when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    const e = await fail(api.postForFile('/exports/table', {}));
    expect(e.status).toBe(0);
    expect(e.message).toContain('injoignable');
  });
});

describe('ApiError.fieldErrors', () => {
  it('maps each refused path to its message', () => {
    const e = new ApiError({
      type: 'about:blank',
      title: 'Requête invalide',
      status: 400,
      detail: 'Certaines valeurs sont invalides.',
      errors: [
        { path: 'salePrice', message: 'Montant invalide.' },
        { path: 'eans.0', message: 'Code-barres invalide.' },
      ],
    });
    expect(e.fieldErrors()).toEqual({
      salePrice: 'Montant invalide.',
      'eans.0': 'Code-barres invalide.',
    });
    expect(e.message).toBe('Certaines valeurs sont invalides.');
    expect(e.status).toBe(400);
  });
  it('is empty for a refusal that is not about a field (409, 403…)', () => {
    const e = new ApiError({
      type: 'about:blank',
      title: 'Conflit',
      status: 409,
      detail: 'Code utilisé.',
    });
    expect(e.fieldErrors()).toEqual({});
  });
});

describe('api requests', () => {
  it('a write carries the anti-CSRF header and a JSON body; a read does not', async () => {
    const fetchMock = reply(200, { id: '1' });
    vi.stubGlobal('fetch', fetchMock);
    await api.post('/suppliers', { name: 'x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/suppliers');
    expect(init.method).toBe('POST');
    expect(init.headers[CSRF_HEADER]).toBe('1');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"name":"x"}');

    const get = reply(200, []);
    vi.stubGlobal('fetch', get);
    await api.get('/communes');
    expect(get.mock.calls[0]![1].headers[CSRF_HEADER]).toBeUndefined();
  });

  it('a refusal becomes an ApiError with the problem of the server', async () => {
    vi.stubGlobal(
      'fetch',
      reply(400, {
        type: 'about:blank',
        title: 'Requête invalide',
        status: 400,
        errors: [{ path: 'postcode', message: 'Code postal à 5 chiffres.' }],
      }),
    );
    const err = await fail(api.post('/communes', {}));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.fieldErrors()).toEqual({ postcode: 'Code postal à 5 chiffres.' });
  });

  it('an answer that is not a problem still gives a readable error', async () => {
    vi.stubGlobal('fetch', reply(502, undefined, 'Bad Gateway'));
    const err = await fail(api.get('/x'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Bad Gateway');
  });

  it('with no network, says so (status 0), so the screens can explain it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await fail(api.get('/x'));
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/injoignable/);
  });

  it('204 gives nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api.delete('/x')).resolves.toBeUndefined();
  });
});
