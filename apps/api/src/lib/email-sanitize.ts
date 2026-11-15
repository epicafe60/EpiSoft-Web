import sanitizeHtml from 'sanitize-html';
import { EMAIL_ASSET_PATH } from '@episoft/shared';

// The HTML of an e-mail is written by a person in the editor, then stored and sent. It is cleaned
// when it is saved: only what an e-mail needs is kept (text, lists, links, tables, the images of
// the library, a few styles). No script, no form, no frame, no remote image, no `javascript:` link,
// no style that loads something. Whatever the browser or a forged request sends.

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]{3,20}$/i];
const LENGTH = [/^-?\d{1,4}(\.\d+)?(px|pt|em|rem|%)?$/];
const BOX = [
  /^(-?\d{1,4}(\.\d+)?(px|pt|em|rem|%)?|auto)( (-?\d{1,4}(\.\d+)?(px|pt|em|rem|%)?|auto)){0,3}$/,
];

const ALLOWED_STYLES: Record<string, RegExp[]> = {
  color: COLOR,
  'background-color': COLOR,
  'font-size': LENGTH,
  'font-weight': [/^(normal|bold|[1-9]00)$/],
  'font-style': [/^(normal|italic)$/],
  'text-decoration': [/^(none|underline|line-through)$/],
  'text-align': [/^(left|right|center|justify)$/],
  'vertical-align': [/^(top|middle|bottom)$/],
  'line-height': [/^\d(\.\d+)?$/, ...LENGTH],
  padding: BOX,
  margin: BOX,
  width: [/^(auto|\d{1,4}(\.\d+)?(px|%))$/],
  'max-width': [/^(none|\d{1,4}(\.\d+)?(px|%))$/],
  height: [/^(auto|\d{1,4}(\.\d+)?(px|%))$/],
  border: [/^(none|\d{1,2}px (solid|dashed|dotted) (#[0-9a-f]{3,8}|[a-z]{3,20}))$/i],
  'border-bottom': [/^(none|\d{1,2}px (solid|dashed|dotted) (#[0-9a-f]{3,8}|[a-z]{3,20}))$/i],
  'border-top': [/^(none|\d{1,2}px (solid|dashed|dotted) (#[0-9a-f]{3,8}|[a-z]{3,20}))$/i],
  'border-collapse': [/^(collapse|separate)$/],
  display: [/^(block|inline|inline-block)$/],
};

const ASSET_SRC = new RegExp(`^${EMAIL_ASSET_PATH.replace(/\//g, '\\/')}[0-9a-f-]{36}$`, 'i');

const BLOCK_ATTRS = ['style', 'align'];

/** The text editors encode `{{lien}}` in an address as %7B%7Blien%7D%7D: put it back. */
const restoreTokens = (html: string) =>
  html.replace(/%7B%7B\s*([a-z][a-z0-9_]*)\s*%7D%7D/gi, '{{$1}}');

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(restoreTokens(html), {
    allowedTags: [
      'p',
      'br',
      'hr',
      'div',
      'span',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'small',
      'sup',
      'sub',
      'h1',
      'h2',
      'h3',
      'h4',
      'blockquote',
      'ul',
      'ol',
      'li',
      'a',
      'img',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
    ],
    allowedAttributes: {
      a: ['href', 'title', ...BLOCK_ATTRS],
      img: ['src', 'alt', 'width', 'height', 'style'],
      table: ['width', 'cellpadding', 'cellspacing', 'border', ...BLOCK_ATTRS],
      td: ['colspan', 'rowspan', 'width', 'valign', ...BLOCK_ATTRS],
      th: ['colspan', 'rowspan', 'width', 'valign', ...BLOCK_ATTRS],
      ol: ['start', ...BLOCK_ATTRS],
      '*': BLOCK_ATTRS,
    },
    allowedStyles: { '*': ALLOWED_STYLES },
    // A `{{lien}}` token in an address has no scheme: it is replaced by a checked web address
    // when the e-mail is sent. Every address that does have a scheme must be a safe one.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      // Only the images of the library: no remote image, no data: image.
      img: (tagName, attribs) => ({
        tagName,
        attribs: ASSET_SRC.test(attribs.src ?? '') ? attribs : {},
      }),
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  }).trim();
}
