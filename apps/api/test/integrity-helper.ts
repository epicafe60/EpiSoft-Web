import { expect } from 'vitest';
import type { Db } from '@episoft/db';
import { runIntegrityChecks } from '../src/modules/admin/integrity';

/** Fails the test with the offending rows when any error-level cross-check is violated. */
export async function expectIntegrity(db: Db) {
  const report = await runIntegrityChecks(db);
  const failing = report.checks.filter((c) => c.severity === 'error' && c.count > 0);
  expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
}
