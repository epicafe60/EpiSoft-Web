import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { smtpOptions } from '../src/lib/mail';

// Review of November 2026 (M6): in production the mail session is encrypted, or nothing is sent.

describe('smtpOptions (M6: encrypted or nothing)', () => {
  const env = (over: Record<string, string>) =>
    loadConfig({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_URL: 'postgres://u:p@localhost/db',
      SMTP_HOST: 'smtp.example.org',
      ...over,
    });

  it('requires STARTTLS in production on any port but 465', () => {
    expect(smtpOptions(env({ SMTP_PORT: '587' }))).toMatchObject({
      secure: false,
      requireTLS: true,
    });
    expect(smtpOptions(env({ SMTP_PORT: '25' }))).toMatchObject({ requireTLS: true });
  });

  it('is encrypted from the start on 465, and does not require it in development', () => {
    expect(smtpOptions(env({ SMTP_PORT: '465' }))).toMatchObject({
      secure: true,
      requireTLS: false,
    });
    const dev = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@localhost/db',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
    });
    expect(smtpOptions(dev)).toMatchObject({ secure: false, requireTLS: false });
  });

  it('sends the credentials only when there are some', () => {
    expect(smtpOptions(env({})).auth).toBeUndefined();
    expect(smtpOptions(env({ SMTP_USER: 'u', SMTP_PASSWORD: 'p' })).auth).toEqual({
      user: 'u',
      pass: 'p',
    });
  });
});
