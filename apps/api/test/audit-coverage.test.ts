import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@episoft/shared';
import { REVERT_POLICIES } from '../src/modules/admin/revert/policies';

// R-ADM-05: every route that writes records what it did. This reads the routes; the check run by
// the test helpers (no change without an action in the same transaction) covers what they write.

/** Routes that answer a POST without writing anything, and why. */
const NO_WRITE: Record<string, string> = {
  'POST /bank/rules/test': 'essaie une règle sur des lignes, sans rien enregistrer',
  'POST /imports/:kind/preview': 'aperçu d’un import, rien n’est enregistré',
  'POST /supplier-invoices/check': 'vérifie une facture avant de la saisir',
};

/** Helpers that record the action themselves. */
const AUDITING_HELPERS = ['closeSession(', 'processOps(', 'await run(tx, req'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return f.endsWith('.ts') ? [p] : [];
  });
}

describe('the journal records every action (R-ADM-05)', () => {
  it('every route that writes calls audit() or a helper that does', () => {
    const route = /app\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*['`]([^'`]+)['`]/g;
    const missing: string[] = [];
    let count = 0;
    for (const file of files(join(process.cwd(), 'src'))) {
      const s = readFileSync(file, 'utf8');
      const found = [...s.matchAll(route)];
      found.forEach((m, i) => {
        count++;
        const body = s.slice(m.index, found[i + 1]?.index ?? s.length);
        const name = `${m[1]!.toUpperCase()} ${m[2]}`;
        if (body.includes('audit(') || AUDITING_HELPERS.some((h) => body.includes(h))) return;
        if (name in NO_WRITE) return;
        missing.push(`${name} (${relative(process.cwd(), file)})`);
      });
    }
    expect(count).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it('every action has a decision on how to undo it (R-ADM-06)', () => {
    const undecided = AUDIT_ACTIONS.filter((a) => !(a in REVERT_POLICIES));
    expect(undecided).toEqual([]);
    expect(Object.keys(REVERT_POLICIES).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});
