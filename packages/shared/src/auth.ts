import { z } from 'zod';
import { normalizeSearch } from './text';

// Authentication rules (spec §4.1, §5.5).

/** R-AUTH-01: at least 10 characters. */
export const PASSWORD_MIN_LENGTH = 10;

export const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Le mot de passe doit comporter au moins ${PASSWORD_MIN_LENGTH} caractères.`,
  )
  .max(200, 'Le mot de passe est trop long.');

export const loginSchema = z.object({
  /** R-EVO-42: the user name or the e-mail given at membership. */
  username: z.string().trim().min(1, 'Identifiant requis.').max(200),
  password: z.string().min(1, 'Mot de passe requis.').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  username: z.string().trim().min(1).max(200),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

/** R-AUTH-03: 5 failures lock the username for 15 minutes. */
export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;

/** R-AUTH-02: the reset link is valid for 1 hour. */
export const PASSWORD_RESET_TTL_MINUTES = 60;

/** §5.5: back-office sessions expire after 8 hours. */
export const SESSION_TTL_HOURS = 8;

export interface LoginAttempt {
  at: Date;
  success: boolean;
}

/**
 * R-AUTH-03. Returns the date until which the username is locked, or null.
 * Only failures after the last success count. Five failures within LOCKOUT_MINUTES
 * of each other lock the username for LOCKOUT_MINUTES from the fifth one.
 */
export function lockedUntil(attempts: readonly LoginAttempt[], now: Date): Date | null {
  const windowMs = LOCKOUT_MINUTES * 60_000;
  const sorted = [...attempts].sort((a, b) => a.at.getTime() - b.at.getTime());
  let failures: number[] = [];
  for (const a of sorted) {
    if (a.success) failures = [];
    else failures.push(a.at.getTime());
  }
  let until: number | null = null;
  for (let i = LOCKOUT_MAX_FAILURES - 1; i < failures.length; i++) {
    const first = failures[i - (LOCKOUT_MAX_FAILURES - 1)]!;
    const fifth = failures[i]!;
    if (fifth - first <= windowMs) until = fifth + windowMs;
  }
  return until !== null && until > now.getTime() ? new Date(until) : null;
}

/** How far back the API must load attempts to evaluate lockedUntil. */
export const LOCKOUT_LOOKBACK_MINUTES = LOCKOUT_MINUTES * 2;

/** R-MBR-01: the suggested username is `Prénom_NOM`, without accents or spaces. */
export function proposeUsername(firstName: string, lastName: string): string {
  const clean = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .trim()
      .replace(/[^A-Za-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const first = clean(firstName);
  const last = clean(lastName).toUpperCase();
  const firstCap = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : '';
  return [firstCap, last].filter(Boolean).join('_');
}

/** Usernames are compared case- and accent-insensitively. */
export function normalizeUsername(username: string): string {
  return normalizeSearch(username);
}
