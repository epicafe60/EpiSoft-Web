import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';

// Audit KV2, S06 (a failed sign-out is said, never hidden) and S03 (the image cache is emptied).

const post = vi.fn();
const confirmNow = vi.fn();
const writeCachedMe = vi.fn();
const forgetPersonalData = vi.fn();
const deleteCache = vi.fn();

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: { post: (...a: unknown[]) => post(...a) },
}));
vi.mock('@/components/confirm', () => ({ confirmNow: (...a: unknown[]) => confirmNow(...a) }));
vi.mock('./auth', () => ({ writeCachedMe: (...a: unknown[]) => writeCachedMe(...a) }));
vi.mock('@/till/db', () => ({ forgetPersonalData: () => forgetPersonalData() }));

const { signOut } = await import('./sign-out');

const unreachable = new ApiError({ type: 'about:blank', title: 'Réseau', status: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('caches', { delete: deleteCache });
});

describe('signOut', () => {
  it('closes the session on the server, then forgets the local copies', async () => {
    post.mockResolvedValueOnce(undefined);
    expect(await signOut()).toBe(true);
    expect(post).toHaveBeenCalledWith('/auth/logout');
    expect(writeCachedMe).toHaveBeenCalledWith(null);
    expect(deleteCache).toHaveBeenCalledWith('episoft-media');
    expect(forgetPersonalData).toHaveBeenCalled();
  });

  it('says so when the server cannot be reached, and stays signed in if asked', async () => {
    post.mockRejectedValueOnce(unreachable);
    confirmNow.mockResolvedValueOnce(false);
    expect(await signOut()).toBe(false);
    expect(confirmNow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Déconnexion impossible' }),
    );
    // Nothing is presented as closed while the session may still be valid.
    expect(writeCachedMe).not.toHaveBeenCalled();
    expect(forgetPersonalData).not.toHaveBeenCalled();
  });

  it('tries again when asked, until the server answers', async () => {
    post.mockRejectedValueOnce(unreachable).mockResolvedValueOnce(undefined);
    confirmNow.mockResolvedValueOnce(true);
    expect(await signOut()).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(writeCachedMe).toHaveBeenCalledWith(null);
  });

  it('takes a session already closed on the server (401) as signed out', async () => {
    post.mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Non', status: 401 }));
    expect(await signOut()).toBe(true);
    expect(confirmNow).not.toHaveBeenCalled();
  });
});
