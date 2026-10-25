import { expect, test, type Page } from '@playwright/test';
import { login, USERS } from '../fixtures';

// Phone-sized screens: the page itself must never scroll sideways (wide tables scroll inside
// their own container), and nothing may be wider than the screen.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const page = document.documentElement.scrollWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Content inside a scrollable container is allowed to be wider than the screen.
      let p: HTMLElement | null = el.parentElement;
      let scrolled = false;
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') {
          scrolled = true;
          break;
        }
        p = p.parentElement;
      }
      if (!scrolled && r.right > vw + 1) {
        offenders.push(
          `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').slice(0, 3).join('.') : ''} → ${Math.round(r.right)}px`,
        );
      }
    }
    return { vw, page, offenders: offenders.slice(0, 6) };
  });
}

const STAFF_PAGES = [
  '/',
  '/membres',
  '/catalogue',
  '/appros/commandes',
  '/appros/stock',
  '/appros/factures',
  '/appros/fournisseurs',
  '/appros/inventaires',
  '/precommandes',
  '/stats',
  '/admin/utilisateurs',
  '/admin/parametres',
  '/admin/controles',
  '/admin/journal',
  '/admin/connexions',
  '/admin/caisse',
  '/admin/adhesions',
  '/membres/nouveau',
  '/catalogue/nouveau',
  '/catalogue/etiquettes',
  '/catalogue/prix',
  '/catalogue/rayons',
  '/catalogue/avis',
  '/appros/fournisseurs/nouveau',
  '/appros/factures/nouvelle',
  '/imports',
  '/compta/ecritures',
  '/compta/ecritures/nouvelle',
  '/compta/propositions',
  '/compta/banque',
  '/compta/editions',
  '/compta/plan',
  '/compta/budget',
  '/compta/cloture',
];

test('staff screens do not overflow a phone screen', async ({ page }) => {
  // About thirty screens in a row: close to the default limit on a busy machine.
  test.setTimeout(120_000);
  await login(page, USERS.admin);
  const problems: string[] = [];
  for (const path of STAFF_PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const o = await overflow(page);
    if (o.page > o.vw + 1 || o.offenders.length)
      problems.push(`${path}: page ${o.page}px / écran ${o.vw}px ; ${o.offenders.join(' ; ')}`);
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('customer screens do not overflow a phone screen', async ({ page }) => {
  await login(page, USERS.customer);
  const problems: string[] = [];
  for (const path of ['/', '/boutique', '/mon-foyer']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const o = await overflow(page);
    if (o.page > o.vw + 1 || o.offenders.length)
      problems.push(`${path}: page ${o.page}px / écran ${o.vw}px ; ${o.offenders.join(' ; ')}`);
  }
  expect(problems, problems.join('\n')).toEqual([]);
});
