import { z } from 'zod';

// R-SES-07: changing the cashier without signing out. The cashier of a ticket is the one chosen on
// the till; when the association asks for it, they confirm with their own 4-digit code. The code
// only says who keeps the till: it never signs anyone in, and the session keeps its own rights.

const TOO_EASY = new Set(['0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '4321']);

export const tillPinSchema = z
  .string()
  .regex(/^\d{4}$/, 'Le code caissier comporte 4 chiffres.')
  .refine((s) => !/^(\d)\1{3}$/.test(s) && !TOO_EASY.has(s), 'Ce code est trop facile à deviner.');

/** PBKDF2 iterations: slow enough to make guessing from a copy of the till costly. */
export const TILL_PIN_ITERATIONS = 100_000;

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** A random salt, as hex (16 bytes). */
export function newTillPinSalt(): string {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * PBKDF2-SHA256 of the code with its salt, as hex, with Web Crypto: the server stores it, the
 * till computes the same to check a code while offline.
 */
export async function hashTillPin(pin: string, saltHex: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: TILL_PIN_ITERATIONS },
    key,
    256,
  );
  return hex(bits);
}

/** Compared in constant time: the till and the server never say how close a code was. */
export async function tillPinMatches(
  pin: string,
  stored: { hash: string; salt: string } | null,
): Promise<boolean> {
  if (!stored || !/^\d{4}$/.test(pin)) return false;
  const computed = await hashTillPin(pin, stored.salt);
  if (computed.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++)
    diff |= computed.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_SECONDS = 60;

/**
 * After PIN_MAX_FAILURES wrong codes in a row, the code of that cashier is refused for
 * PIN_LOCK_SECONDS. Returns when it is usable again, or null.
 */
export function pinLockedUntil(failures: readonly Date[], now: Date): Date | null {
  if (failures.length < PIN_MAX_FAILURES) return null;
  const last = failures[failures.length - 1]!;
  const until = new Date(last.getTime() + PIN_LOCK_SECONDS * 1000);
  return until > now ? until : null;
}

/** How the cashier of a till operation was established (recorded with it in the journal). */
export const CASHIER_CHECKS = ['SESSION', 'PIN', 'DECLARED'] as const;
export type CashierCheck = (typeof CASHIER_CHECKS)[number];

/**
 * R-SES-07: after this many minutes without a ticket, the till asks again who keeps it (when the
 * code is required): a till left open does not keep selling in the name of the last cashier.
 */
export const CASHIER_IDLE_MINUTES = 15;

export function cashierStale(lastActivityAt: Date | null, now: Date): boolean {
  return (
    lastActivityAt !== null &&
    now.getTime() - lastActivityAt.getTime() > CASHIER_IDLE_MINUTES * 60_000
  );
}
