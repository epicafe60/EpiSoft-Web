import { describe, expect, it } from 'vitest';
import { lockedUntil, passwordSchema, proposeUsername, type LoginAttempt } from './auth';

const t0 = new Date('2026-10-03T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const fail = (min: number): LoginAttempt => ({ at: at(min), success: false });
const ok = (min: number): LoginAttempt => ({ at: at(min), success: true });

describe('R-AUTH-01 password policy', () => {
  it('requires at least 10 characters', () => {
    expect(passwordSchema.safeParse('123456789').success).toBe(false);
    expect(passwordSchema.safeParse('1234567890').success).toBe(true);
  });
});

describe('R-AUTH-03 lockout', () => {
  it('is not locked after 4 failures', () => {
    expect(lockedUntil([fail(0), fail(1), fail(2), fail(3)], at(4))).toBeNull();
  });

  it('locks for 15 minutes from the 5th failure', () => {
    const attempts = [fail(0), fail(1), fail(2), fail(3), fail(4)];
    expect(lockedUntil(attempts, at(5))).toEqual(at(19));
    expect(lockedUntil(attempts, at(18.9))).toEqual(at(19));
    expect(lockedUntil(attempts, at(19))).toBeNull();
  });

  it('a success resets the counter', () => {
    expect(lockedUntil([fail(0), fail(1), fail(2), ok(3), fail(4), fail(5)], at(6))).toBeNull();
  });

  it('failures older than 15 minutes do not count', () => {
    expect(lockedUntil([fail(0), fail(1), fail(20), fail(21), fail(22)], at(23))).toBeNull();
  });

  it('ignores input order', () => {
    const attempts = [fail(4), fail(2), fail(0), fail(3), fail(1)];
    expect(lockedUntil(attempts, at(5))).toEqual(at(19));
  });
});

describe('R-MBR-01 username proposal', () => {
  it('builds Prénom_NOM without accents', () => {
    expect(proposeUsername('Hélène', 'Dupré')).toBe('Helene_DUPRE');
  });

  it('handles compound names', () => {
    expect(proposeUsername('jean pierre', "d'Arc")).toBe('Jean-pierre_D-ARC');
  });

  it('copes with a missing first name', () => {
    expect(proposeUsername('', 'Martin')).toBe('MARTIN');
  });
});
