import { describe, expect, it } from 'vitest';
import { cellText, readTable, type CellLike, type NodeLike, type TableLike } from './table-dom';

// Reading a displayed table into headers and rows, with plain objects standing for the DOM.

const text = (v: string): NodeLike => ({ nodeType: 3, nodeValue: v });
const el = (
  tagName: string,
  children: NodeLike[] = [],
  props: Partial<NodeLike> & { cls?: string } = {},
): NodeLike => {
  const { cls, ...rest } = props;
  return {
    nodeType: 1,
    tagName,
    childNodes: children,
    getAttribute: (n) => (n === 'class' ? (cls ?? null) : null),
    hasAttribute: () => false,
    ...rest,
  };
};
const cell = (children: NodeLike[], colSpan = 1): CellLike => ({ ...el('TD', children), colSpan });
const row = (...cells: CellLike[]) => ({ cells });
const table = (head: CellLike[], body: ReturnType<typeof row>[]): TableLike => ({
  tHead: { rows: [row(...head)] },
  tBodies: [{ rows: body }],
});

describe('cellText', () => {
  it('reads text, nested elements and a button label', () => {
    expect(cellText(el('TD', [text('Lentilles '), el('SPAN', [text('bio')])]))).toBe(
      'Lentilles bio',
    );
    expect(cellText(el('TD', [el('BUTTON', [text('Annuler')])]))).toBe('Annuler');
  });

  it('says the chosen option of a select, not every option', () => {
    const select = el('SELECT', [text('NouveauAccepté')], {
      selectedOptions: [{ textContent: 'Accepté' }],
    });
    expect(cellText(el('TD', [select]))).toBe('Accepté');
  });

  it('reads the value of a field, Oui or Non for a box, and nothing for a search box', () => {
    expect(cellText(el('INPUT', [], { type: 'text', value: '12,5' }))).toBe('12,5');
    expect(cellText(el('INPUT', [], { type: 'checkbox', checked: true }))).toBe('Oui');
    expect(cellText(el('INPUT', [], { type: 'checkbox', checked: false }))).toBe('Non');
    expect(cellText(el('INPUT', [], { type: 'search', value: 'filtre' }))).toBe('');
  });

  it('leaves out what is for screen readers, icons and what is marked not to export', () => {
    expect(cellText(el('SPAN', [text('caché')], { cls: 'sr-only' }))).toBe('');
    expect(cellText(el('SVG', [text('x')]))).toBe('');
    const marked = el('SPAN', [text('interne')], { hasAttribute: (n) => n === 'data-no-export' });
    expect(cellText(marked)).toBe('');
  });
});

describe('readTable', () => {
  it('reads the headers and the rows as displayed', () => {
    const t = table(
      [cell([text('Nom')]), cell([text('Solde')])],
      [
        row(cell([text('DUPONT')]), cell([text('12,50 €')])),
        row(cell([text('MARTIN')]), cell([text('0,00 €')])),
      ],
    );
    expect(readTable(t)).toEqual({
      headers: ['Nom', 'Solde'],
      rows: [
        ['DUPONT', '12,50 €'],
        ['MARTIN', '0,00 €'],
      ],
    });
  });

  it('takes the text of a sortable header without its filter box', () => {
    const th = cell([
      el('BUTTON', [text('Nom')]),
      el('INPUT', [], { type: 'search', value: 'du' }),
    ]);
    expect(readTable(table([th], [row(cell([text('DUPONT')]))])).headers).toEqual(['Nom']);
  });

  it('leaves out a column with no header and a column of buttons', () => {
    const t = table(
      [cell([text('Nom')]), cell([]), cell([text('Actions')]), cell([text('Ville')])],
      [
        row(
          cell([text('DUPONT')]),
          cell([el('BUTTON', [text('Ouvrir')])]),
          cell([text('x')]),
          cell([text('Lille')]),
        ),
      ],
    );
    expect(readTable(t)).toEqual({ headers: ['Nom', 'Ville'], rows: [['DUPONT', 'Lille']] });
  });

  it('skips a loading or empty-state row spanning the table, and keeps a record with one value', () => {
    const t = table(
      [cell([text('Nom')]), cell([text('Ville')])],
      [row(cell([text('Chargement…')], 2)), row(cell([text('DUPONT')]), cell([text('Lille')]))],
    );
    expect(readTable(t).rows).toEqual([['DUPONT', 'Lille']]);
    const one = table([cell([text('Nom')])], [row(cell([text('DUPONT')]))]);
    expect(readTable(one).rows).toEqual([['DUPONT']]);
  });

  it('pads a short row and collapses spaces of every kind', () => {
    const t = table(
      [cell([text('A')]), cell([text('B')]), cell([text('C')])],
      [row(cell([text('1\u202f234,00\u00a0€\n')]), cell([text('x')]))],
    );
    expect(readTable(t).rows).toEqual([['1 234,00 €', 'x', '']]);
  });

  it('gives nothing for a table without a header', () => {
    expect(readTable({ tBodies: [] })).toEqual({ headers: [], rows: [] });
  });
});
