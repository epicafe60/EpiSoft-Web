import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** Random URL-safe token (256 bits). Only its SHA-256 is stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// R-AUTH-01: Argon2id (the @node-rs/argon2 default), OWASP-recommended parameters.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false);
}

// Verified against when the user does not exist, so timing does not reveal valid usernames.
let dummyHash: Promise<string> | undefined;
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}
