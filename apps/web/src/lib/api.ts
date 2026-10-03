import { CSRF_HEADER, type Problem } from '@episoft/shared';

/** A failed API call, carrying the problem+json body (spec §8.1). */
export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
  get status() {
    return this.problem.status;
  }
  /** Field errors by path, for forms. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.problem.errors ?? []).map((e) => [e.path, e.message]));
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // R-OFF-08: back-office functions need the network; say so clearly.
    throw new ApiError({
      type: 'about:blank',
      title: 'Hors ligne',
      status: 0,
      detail: 'Le serveur est injoignable. Vérifiez la connexion réseau.',
    });
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      data && typeof data === 'object' && 'status' in data
        ? (data as Problem)
        : { type: 'about:blank', title: 'Erreur', status: res.status, detail: res.statusText },
    );
  }
  return data as T;
}

async function upload<T>(path: string, file: Blob): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: 'PUT',
    headers: { [CSRF_HEADER]: '1', 'content-type': file.type },
    credentials: 'same-origin',
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok)
    throw new ApiError(
      (data as Problem) ?? { type: 'about:blank', title: 'Erreur', status: res.status },
    );
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T = void>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T = void>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T = void>(path: string, body: unknown) => request<T>('PATCH', path, body),
  /** Raw body upload (images). */
  upload: <T = void>(path: string, file: Blob) => upload<T>(path, file),
};
