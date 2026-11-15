import sanitizeHtml from 'sanitize-html';
import { pdfText, type Doc } from './pdf';

// The text zones of the PDF documents (header, supplier, notes, footer) are written by the
// administrators in a rich-text editor. What is kept is cleaned when it is saved (sanitizePdfHtml),
// and drawn here with pdfkit: paragraphs, headings, bold, italic, underline, colour, alignment, lists.
// Nothing else exists in a PDF text: no link, no image, no table.

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z]{3,20}$/i];

export function sanitizePdfHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      'h1',
      'h2',
      'h3',
      'ul',
      'ol',
      'li',
      'span',
    ],
    allowedAttributes: { '*': ['style'] },
    allowedStyles: {
      '*': {
        color: COLOR,
        'text-align': [/^(left|right|center|justify)$/],
      },
    },
    disallowedTagsMode: 'discard',
  }).trim();
}

// --- Reading ------------------------------------------------------------------------------------

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
}

type Align = 'left' | 'right' | 'center' | 'justify';

export interface Block {
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'li';
  align: Align;
  runs: Run[];
  /** « • » or « 1. » for a list item. */
  bullet: string | null;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&laquo;': '«',
  '&raquo;': '»',
};
const decode = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39|nbsp|laquo|raquo);/g, (e) => ENTITIES[e] ?? e);

/** `rgb(1, 2, 3)` or `#abc` as `#rrggbb`; null for what pdfkit would not understand. */
function hexColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(v);
  if (rgb)
    return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return /^[a-z]{3,20}$/.test(v) ? v : null;
}

const styleOf = (attrs: string, prop: string) =>
  new RegExp(`${prop}\\s*:\\s*([^;"']+)`, 'i').exec(attrs)?.[1];

/** The blocks of an HTML that was cleaned by sanitizePdfHtml (what the editor saves). */
export function parsePdfHtml(html: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let bold = 0;
  let italic = 0;
  let underline = 0;
  const colors: (string | null)[] = [];
  const lists: { ordered: boolean; n: number }[] = [];

  const open = (kind: Block['kind'], attrs: string, bullet: string | null = null) => {
    close();
    const align = styleOf(attrs, 'text-align')?.trim().toLowerCase();
    current = {
      kind,
      align: align === 'center' || align === 'right' || align === 'justify' ? align : 'left',
      runs: [],
      bullet,
    };
  };
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  const add = (text: string) => {
    if (!current) open('p', '');
    current!.runs.push({
      text,
      bold: bold > 0,
      italic: italic > 0,
      underline: underline > 0,
      color: colors.at(-1) ?? null,
    });
  };

  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const text = decode(m[4]).replace(/\s+/g, ' ');
      if (text.trim() || current) add(text);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';
    switch (tag) {
      case 'p':
      case 'h1':
      case 'h2':
      case 'h3':
        if (closing) close();
        else open(tag, attrs);
        break;
      case 'ul':
      case 'ol':
        close();
        if (closing) lists.pop();
        else lists.push({ ordered: tag === 'ol', n: 0 });
        break;
      case 'li':
        if (closing) close();
        else {
          const list = lists.at(-1);
          if (list) list.n++;
          open('li', attrs, list?.ordered ? `${list.n}.` : '•');
        }
        break;
      case 'br':
        // The break belongs to the text before it: a run of its own would be drawn without its line.
        if (!closing) {
          const last = (current as Block | null)?.runs.at(-1);
          if (last) last.text += '\n';
          else add('\n');
        }
        break;
      case 'strong':
      case 'b':
        bold += closing ? -1 : 1;
        break;
      case 'em':
      case 'i':
        italic += closing ? -1 : 1;
        break;
      case 'u':
        underline += closing ? -1 : 1;
        break;
      case 'span':
        if (closing) colors.pop();
        else colors.push(hexColor(styleOf(attrs, 'color')) ?? colors.at(-1) ?? null);
        break;
    }
  }
  close();
  // A line break at the end of a block is not a line.
  for (const b of blocks) {
    const last = b.runs.at(-1);
    if (last) last.text = last.text.replace(/\n+$/, '');
    b.runs = b.runs.filter((r) => r.text !== '');
  }
  return blocks;
}

// --- Drawing ------------------------------------------------------------------------------------

const SIZES = { p: 10, li: 10, h1: 15, h2: 13, h3: 11.5 } as const;
const GAP = 4;
const INDENT = 14;

function fontOf(b: Block, r: Run): string {
  const bold = r.bold || (b.kind !== 'p' && b.kind !== 'li');
  if (bold && r.italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  return r.italic ? 'Helvetica-Oblique' : 'Helvetica';
}

/** The runs of a block, cut at its line breaks: the runs of each line. */
function splitLines(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const r of runs)
    r.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== '') lines.at(-1)!.push({ ...r, text: part });
    });
  return lines;
}

/** Draws the zone at (x, y), `width` wide; returns where the next thing may start. */
export function drawPdfHtml(doc: Doc, html: string, x: number, y: number, width: number): number {
  let at = y;
  for (const b of parsePdfHtml(html)) {
    const size = SIZES[b.kind];
    const left = x + (b.bullet ? INDENT : 0);
    const w = width - (b.bullet ? INDENT : 0);
    if (!b.runs.length) {
      // An empty paragraph is a blank line.
      at += size * 1.2 + GAP;
      continue;
    }
    if (b.bullet) {
      doc.font('Helvetica').fontSize(size).fillColor('#000000');
      doc.text(b.bullet, x, at, { width: INDENT, lineBreak: false });
    }
    // One line at a time (a line break is not drawn inside a run that goes on): the runs of a line
    // follow each other, each in its own style.
    for (const line of splitLines(b.runs)) {
      if (!line.length) {
        at += size * 1.2;
        continue;
      }
      line.forEach((r, i) => {
        doc
          .font(fontOf(b, r))
          .fontSize(size)
          .fillColor(r.color ?? '#000000');
        const options = {
          continued: i < line.length - 1,
          underline: r.underline,
          align: b.align,
          width: w,
        };
        if (i === 0) doc.text(pdfText(r.text), left, at, options);
        else doc.text(pdfText(r.text), options);
      });
      at = doc.y;
    }
    at += GAP;
  }
  doc.fillColor('#000000').font('Helvetica').fontSize(10);
  return at;
}

/** How tall a zone is, to leave room for it (a footer at the bottom of the page). */
export function heightOfPdfHtml(doc: Doc, html: string, width: number): number {
  let h = 0;
  for (const b of parsePdfHtml(html)) {
    const size = SIZES[b.kind];
    const w = width - (b.bullet ? INDENT : 0);
    const text = b.runs.map((r) => r.text).join('');
    doc.font(fontOf(b, b.runs[0] ?? ({ bold: false, italic: false } as Run))).fontSize(size);
    h += (text ? doc.heightOfString(pdfText(text), { width: w }) : size * 1.2) + GAP;
  }
  doc.font('Helvetica').fontSize(10);
  return h;
}

/** The text of a zone, for tests and for a plain reading. */
export function pdfHtmlLines(html: string): string[] {
  return parsePdfHtml(html).map(
    (b) => `${b.bullet ? `${b.bullet} ` : ''}${b.runs.map((r) => r.text).join('')}`,
  );
}
