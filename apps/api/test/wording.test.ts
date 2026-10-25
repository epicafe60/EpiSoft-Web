import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_SENTENCES } from '@episoft/shared';

// Volunteers read these screens and messages: no rule code (R-VTE-02…) may appear in them.
// Rule codes live in comments, tests and the documents.

const ROOTS = ['../web/src', 'src', '../../packages/shared/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

describe('the journal of changes', () => {
  it('has a plain sentence for every action the application records', () => {
    const actions = new Set<string>();
    for (const file of files(join(process.cwd(), 'src')))
      for (const m of readFileSync(file, 'utf8').matchAll(/action:\s*'([a-z_]+\.[a-z_.]+)'/g))
        actions.add(m[1]!);
    expect(actions.size).toBeGreaterThan(50);
    const missing = [...actions].filter((a) => !(a in AUDIT_SENTENCES));
    expect(missing).toEqual([]);
  });
});

describe('links given by the server', () => {
  it('« À surveiller » and the integrity checks only point at pages that exist', () => {
    const router = readFileSync(join(process.cwd(), '../web/src/router.tsx'), 'utf8');
    const paths = new Set([...router.matchAll(/path: '([^']+)'/g)].map((m) => m[1]!));
    const links = new Set<string>();
    // `link: '/x'`, `to: '/x'`, `'/x' as link` and `'/foyers/' || h.id` (a page by its id).
    const pattern = /(?:(?:link|to): '(\/[a-z/-]*)'|'(\/[a-z/-]*)' (?:as link|\|\|))/g;
    for (const f of ['src/modules/admin/attention.ts', 'src/modules/admin/integrity.ts'])
      for (const m of readFileSync(join(process.cwd(), f), 'utf8').matchAll(pattern))
        links.add((m[1] ?? m[2])!.replace(/\/$/, '/$id'));
    expect(links.size).toBeGreaterThan(8);
    const dead = [...links].filter((link) => {
      if (paths.has(link)) return false;
      // A child route: '/surveillance/erreurs' is '/surveillance' with the child '/erreurs'.
      const parts = link.split('/').filter(Boolean);
      return !parts.some(
        (_, k) =>
          k > 0 &&
          paths.has('/' + parts.slice(0, k).join('/')) &&
          paths.has('/' + parts.slice(k).join('/')),
      );
    });
    expect(dead).toEqual([]);
  });
});

describe('confirmations', () => {
  it('use the application window, never the browser’s native confirm or prompt', () => {
    const offenders: string[] = [];
    for (const file of files(join(process.cwd(), '../web/src'))) {
      if (file.endsWith('confirm.tsx')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/window\.(confirm|prompt|alert)\(/.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('user-visible wording', () => {
  it('shows no rule code to the users', () => {
    const offenders: string[] = [];
    for (const root of ROOTS)
      for (const file of files(join(process.cwd(), root))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const t = line.trim();
            if (/^(\/\/|\*|\/\*|\{\/\*)/.test(t) || line.includes('{/*')) return;
            const k = line.indexOf(' // ');
            const code = k >= 0 ? line.slice(0, k) : line;
            if (/R-[A-Z]{3}-\d{2}/.test(code)) offenders.push(`${file}:${i + 1}`);
          });
      }
    expect(offenders).toEqual([]);
  });
});
