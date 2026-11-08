import { describe, expect, it } from 'vitest';
import {
  cashierStale,
  hashTillPin,
  newTillPinSalt,
  pinLockedUntil,
  TILL_PIN_ITERATIONS,
  tillPinMatches,
  tillPinSchema,
} from './till-pin';

describe('R-SES-07 — the cashier code', () => {
  it('is 4 digits, and not one that is easy to guess', () => {
    expect(tillPinSchema.safeParse('4815').success).toBe(true);
    for (const bad of ['123', '12345', 'abcd', '0000', '7777', '1234', '4321'])
      expect(tillPinSchema.safeParse(bad).success, bad).toBe(false);
  });

  it('is hashed with standard PBKDF2-SHA256, so the till checks it offline', async () => {
    expect(newTillPinSalt()).toMatch(/^[0-9a-f]{32}$/);
    expect(TILL_PIN_ITERATIONS).toBe(100_000);
    // Reference value computed with Node's crypto.pbkdf2Sync('4815', salt, 100000, 32, 'sha256').
    expect(await hashTillPin('4815', '00112233445566778899aabbccddeeff')).toBe(
      'c3af463481f4c73c5a178943b3273cd05cb090519d010c5052d0b3cecc9483de',
    );
  });

  it('matches only the right code, and never without a stored code', async () => {
    const salt = newTillPinSalt();
    const stored = { hash: await hashTillPin('4815', salt), salt };
    expect(await tillPinMatches('4815', stored)).toBe(true);
    expect(await tillPinMatches('4816', stored)).toBe(false);
    expect(await tillPinMatches('4815', null)).toBe(false);
    expect(await tillPinMatches('48a5', stored)).toBe(false);
  });

  it('is refused for a minute after five wrong codes', () => {
    const now = new Date('2026-11-08T12:00:30Z');
    const at = (s: number) => new Date(`2026-11-08T12:00:${String(s).padStart(2, '0')}Z`);
    expect(pinLockedUntil([at(1), at(2), at(3), at(4)], now)).toBeNull();
    expect(pinLockedUntil([at(1), at(2), at(3), at(4), at(5)], now)).toEqual(
      new Date('2026-11-08T12:01:05Z'),
    );
    expect(
      pinLockedUntil([at(1), at(2), at(3), at(4), at(5)], new Date('2026-11-08T12:02:00Z')),
    ).toBeNull();
  });

  it('asks again who keeps the till after 15 minutes without a ticket', () => {
    const last = new Date('2026-11-08T12:00:00Z');
    expect(cashierStale(last, new Date('2026-11-08T12:14:00Z'))).toBe(false);
    expect(cashierStale(last, new Date('2026-11-08T12:16:00Z'))).toBe(true);
    expect(cashierStale(null, new Date('2026-11-08T12:16:00Z'))).toBe(false);
  });
});
