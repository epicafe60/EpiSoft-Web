import { describe, expect, it } from 'vitest';
import {
  APP_VARIABLES,
  assetIdsIn,
  DEFAULT_EMAIL_LAYOUT,
  EMAIL_TEMPLATES,
  emailLayoutSchema,
  emailTemplateSaveSchema,
  fillHtml,
  fillText,
  htmlToText,
  oneLine,
  sampleValues,
  templateDef,
  templateProblems,
  usedVariables,
  type TemplateDef,
  type TemplateVariable,
} from './email-templates';

const vars: TemplateVariable[] = [
  { name: 'prenom', label: 'Prénom', sample: 'Marie', kind: 'text' },
  { name: 'tableau', label: 'Tableau', sample: '<b>x</b>', kind: 'html' },
  { name: 'lien', label: 'Lien', sample: 'https://exemple.org', kind: 'url', required: true },
];

describe('the wording the application ships with', () => {
  it('has a unique key and a label for every e-mail', () => {
    const keys = EMAIL_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(EMAIL_TEMPLATES.length).toBeGreaterThanOrEqual(19);
    for (const t of EMAIL_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it.each(EMAIL_TEMPLATES.map((t) => [t.key, t as TemplateDef]))(
    '%s: uses only its own variables and satisfies its own rules',
    (_key, def) => {
      expect(templateProblems(def, def.subject, def.body)).toEqual([]);
      // Each declared variable is used somewhere, and the preview leaves no token behind.
      const used = new Set([...usedVariables(def.subject), ...usedVariables(def.body)]);
      // (the names of the association are available everywhere, used or not)
      for (const v of def.variables.filter((x) => !APP_VARIABLES.some((a) => a.name === x.name)))
        expect(used.has(v.name), `${def.key}: {{${v.name}}}`).toBe(true);
      const values = sampleValues(def);
      expect(fillHtml(def.body, values, def.variables)).not.toMatch(/\{\{/);
      expect(fillText(def.subject, values, def.variables)).not.toMatch(/\{\{/);
    },
  );

  it('an e-mail with a link cannot be saved without it', () => {
    const def = templateDef('password_link')!;
    expect(templateProblems(def, def.subject, '<p>Bonjour {{prenom}}</p>')).toEqual([
      expect.stringContaining('{{lien}} est indispensable'),
    ]);
  });
});

describe('filling the variables', () => {
  it('escapes a text, whatever it holds: a name cannot add HTML', () => {
    const out = fillHtml('<p>{{prenom}}</p>', { prenom: '<script>alert(1)</script> & "x"' }, vars);
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>');
  });

  it('writes a fragment of the application as it is', () => {
    expect(fillHtml('{{tableau}}', { tableau: '<table><tr><td>1</td></tr></table>' }, vars)).toBe(
      '<table><tr><td>1</td></tr></table>',
    );
  });

  it('writes an address only when it is a web address', () => {
    const href = (v: string) => fillHtml('<a href="{{lien}}">x</a>', { lien: v }, vars);
    expect(href('https://exemple.org/a?b=1&c=2')).toBe(
      '<a href="https://exemple.org/a?b=1&amp;c=2">x</a>',
    );
    expect(href('javascript:alert(1)')).toBe('<a href="">x</a>');
    expect(href('https://x.org" onclick="evil')).toBe('<a href="">x</a>');
    expect(href('data:text/html;base64,AAAA')).toBe('<a href="">x</a>');
    expect(href('')).toBe('<a href="">x</a>');
  });

  it('drops a variable that does not exist, and a missing value', () => {
    expect(fillHtml('a{{inconnue}}b{{prenom}}c', {}, vars)).toBe('abc');
    expect(fillHtml('{{ prenom }}', { prenom: 'Léa' }, vars)).toBe('Léa');
  });

  it('does not play twice: a value that looks like a variable stays text', () => {
    expect(fillHtml('{{prenom}}', { prenom: '{{lien}}' }, vars)).toBe('{{lien}}');
  });

  it('writes the text version without escaping, and turns a fragment into text', () => {
    expect(fillText('Bonjour {{prenom}}', { prenom: 'A & B' }, vars)).toBe('Bonjour A & B');
    expect(fillText('{{tableau}}', { tableau: '<p>Un<br>deux</p>' }, vars)).toBe('Un\ndeux');
  });

  it('keeps a subject on one line', () => {
    expect(oneLine('Épicafé :\r\n  ticket\t12 ')).toBe('Épicafé : ticket 12');
  });
});

describe('htmlToText', () => {
  it('reads paragraphs, line breaks, lists and links', () => {
    const text = htmlToText(
      '<h2>Titre</h2><p>Bonjour<br>Marie &amp; Paul</p><ul><li>un</li><li>deux</li></ul>' +
        '<p><a href="https://exemple.org">Ouvrir</a> <a href="https://x.org">https://x.org</a></p>',
    );
    expect(text).toContain('Titre');
    expect(text).toContain('Bonjour\nMarie & Paul');
    expect(text).toContain('- un');
    expect(text).toContain('- deux');
    expect(text).toContain('Ouvrir (https://exemple.org)');
    expect(text.match(/https:\/\/x\.org/g)).toHaveLength(1);
  });

  it('drops scripts and styles and any other tag', () => {
    expect(htmlToText('<style>p{}</style><script>evil()</script><b>gras</b>')).toBe('gras');
  });
});

describe('what an administrator may save', () => {
  const def = templateDef('wallet_low')!;

  it('names the unknown variables and the ones that cannot be in a subject', () => {
    expect(templateProblems(def, 'Bonjour {{prenom}}', '<p>{{message}} {{nimporte}}</p>')).toEqual([
      expect.stringContaining('{{nimporte}}'),
    ]);
    const receipt = templateDef('sale_receipt')!;
    expect(templateProblems(receipt, 'Ticket {{lignes}}', '{{lignes}}')).toEqual([
      expect.stringContaining('ne peut pas être dans l’objet'),
    ]);
  });

  it('refuses a typed text or a fragment inside a link or a tag, accepts the address of the application', () => {
    const link = templateDef('password_link')!;
    const ok = '<a href="{{lien}}">ouvrir</a> {{lien}}';
    expect(templateProblems(link, link.subject, ok)).toEqual([]);
    // A text a person wrote (a title, a name) must never become the address of a link.
    expect(templateProblems(link, link.subject, `${ok}<a href="{{prenom}}">x</a>`)).toEqual([
      expect.stringContaining('ne peut pas être dans un lien'),
    ]);
    // ... even with other words around it, in single quotes, or in capitals.
    expect(templateProblems(link, link.subject, `${ok}<A HREF='x{{prenom}}'>x</A>`)).toHaveLength(
      1,
    );
    const receipt = templateDef('sale_receipt')!;
    // A fragment of HTML inside an attribute would break out of it.
    expect(
      templateProblems(receipt, receipt.subject, `${receipt.body}<p title="{{lignes}}">x</p>`),
    ).toEqual([expect.stringContaining('ne peut pas être dans un attribut (title)')]);
    // A text is harmless in the other attributes.
    expect(
      templateProblems(receipt, receipt.subject, `${receipt.body}<img alt="{{prenom}}">`),
    ).toEqual([]);
  });

  it('accepts a plain edit', () => {
    expect(templateProblems(def, 'Votre cagnotte, {{prenom}}', '<p>{{message}}</p>')).toEqual([]);
  });

  it('refuses an empty subject or message, and an endless one', () => {
    expect(emailTemplateSaveSchema.safeParse({ subject: ' ', body: 'x' }).success).toBe(false);
    expect(emailTemplateSaveSchema.safeParse({ subject: 'x', body: ' ' }).success).toBe(false);
    expect(emailTemplateSaveSchema.safeParse({ subject: 'x'.repeat(201), body: 'x' }).success).toBe(
      false,
    );
    expect(
      emailTemplateSaveSchema.safeParse({ subject: 'x', body: 'x'.repeat(40_001) }).success,
    ).toBe(false);
  });
});

describe('the common layout', () => {
  it('accepts the default and refuses a wrong colour or image id', () => {
    expect(emailLayoutSchema.safeParse(DEFAULT_EMAIL_LAYOUT).success).toBe(true);
    expect(
      emailLayoutSchema.safeParse({ ...DEFAULT_EMAIL_LAYOUT, accentColor: 'green' }).success,
    ).toBe(false);
    expect(
      emailLayoutSchema.safeParse({ ...DEFAULT_EMAIL_LAYOUT, accentColor: '#14532d;x' }).success,
    ).toBe(false);
    expect(
      emailLayoutSchema.safeParse({ ...DEFAULT_EMAIL_LAYOUT, headerImageId: 'abc' }).success,
    ).toBe(false);
  });

  it('finds the images a piece of HTML uses, once each', () => {
    const a = '0190a0a0-0000-7000-8000-000000000001';
    const b = '0190a0a0-0000-7000-8000-000000000002';
    expect(
      assetIdsIn(
        `<img src="/api/v1/email-assets/${a}"><img src="/api/v1/email-assets/${b}"><img src="/api/v1/email-assets/${a}">` +
          '<img src="https://autre.org/x.png">',
      ),
    ).toEqual([a, b]);
  });
});
