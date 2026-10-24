import { expect } from 'vitest';
import type { Db } from '@episoft/db';
import { runIntegrityChecks } from '../src/modules/admin/integrity';

/** Fails the test with the offending rows when any error-level cross-check is violated. */
export async function expectIntegrity(db: Db) {
  const report = await runIntegrityChecks(db);
  // SYN-01 (a refused ticket waits to be dealt with) is an alert for the people who run the
  // shop, not a calculation gone wrong: the scenarios that refuse tickets on purpose leave it on.
  const failing = report.checks.filter(
    (c) => c.severity === 'error' && c.count > 0 && c.id !== 'SYN-01',
  );
  expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
}
