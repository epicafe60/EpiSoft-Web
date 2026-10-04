import { describe, expect, it } from 'vitest';
import {
  detectAndParse,
  findHouseholdByReference,
  fingerprints,
  matchingEntryLines,
  matchingInvoices,
  autoMatchPick,
  suggestRules,
  matchRule,
  parseBankAmount,
  parseBankDate,
  parseCamt053,
  parseCsv,
  parseOfx,
  renderLabelTemplate,
  ruleMatches,
  statementGapCents,
  validateRegex,
  BankParseError,
  type BankRuleLike,
} from './bank';

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>EUR
<BANKACCTFROM><BANKID>12006<ACCTID>FR7612006000000000001<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260201<DTEND>20260228
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260203120000[0:GMT]
<TRNAMT>30,00
<FITID>2026020301
<NAME>VIR SEPA FAVEUR EPICAFE
<MEMO>REF RF544629
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260210
<TRNAMT>-255.64
<FITID>2026021002
<NAME>VIR INST vers Les Bons Miels
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1234,56<DTASOF>20260228</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('amounts and dates', () => {
  it('reads French and English amounts', () => {
    expect([
      parseBankAmount('1 234,56'),
      parseBankAmount('-12.5'),
      parseBankAmount('12,50 €'),
      parseBankAmount('abc'),
    ]).toEqual([123456, -1250, 1250, null]);
  });

  it('reads the usual date formats and rejects impossible dates', () => {
    expect([
      parseBankDate('20260105120000[0:GMT]'),
      parseBankDate('2026-01-05'),
      parseBankDate('05/01/2026'),
      parseBankDate('05-01-26'),
      parseBankDate('31/02/2026'),
    ]).toEqual(['2026-01-05', '2026-01-05', '2026-01-05', '2026-01-05', null]);
  });
});

describe('OFX (R-CPT-12)', () => {
  it('reads SGML without closing tags, keeps labels as received, takes the sign from the amount', () => {
    const s = parseOfx(OFX);
    expect(s).toMatchObject({
      format: 'OFX',
      accountId: 'FR7612006000000000001',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      closingCents: 123456,
    });
    expect(s.transactions).toEqual([
      {
        fitid: '2026020301',
        date: '2026-02-03',
        amountCents: 3000,
        label: 'VIR SEPA FAVEUR EPICAFE',
        memo: 'REF RF544629',
      },
      {
        fitid: '2026021002',
        date: '2026-02-10',
        amountCents: -25564,
        label: 'VIR INST vers Les Bons Miels',
        memo: null,
      },
    ]);
    // opening = closing − Σ transactions
    expect(s.openingCents).toBe(123456 - (3000 - 25564));
  });

  it('refuses a file that is not OFX', () => {
    expect(() => parseOfx('hello')).toThrow(BankParseError);
  });
});

describe('CSV', () => {
  it('reads a semicolon file with debit and credit columns', () => {
    const s = parseCsv(
      'Date;Libellé;Débit;Crédit\n03/02/2026;"REMISE CARTE; 02/02";;12,50\n10/02/2026;PRLV TENUE DE COMPTE;3,00;\n',
    );
    expect(s.transactions).toEqual([
      {
        fitid: null,
        date: '2026-02-03',
        amountCents: 1250,
        label: 'REMISE CARTE; 02/02',
        memo: null,
      },
      {
        fitid: null,
        date: '2026-02-10',
        amountCents: -300,
        label: 'PRLV TENUE DE COMPTE',
        memo: null,
      },
    ]);
    expect(s.periodStart).toBe('2026-02-03');
  });

  it('reads a single signed amount column and reports the faulty line', () => {
    expect(parseCsv('date,label,amount\n2026-02-03,A,-5.5\n').transactions[0]!.amountCents).toBe(
      -550,
    );
    expect(() => parseCsv('date,label,amount\n2026-02-03,A,xx\n')).toThrow(/Ligne 2/);
    expect(() => parseCsv('foo,bar\n1,2\n')).toThrow(/Colonnes attendues/);
  });
});

describe('CAMT.053', () => {
  const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Acct><Id><IBAN>FR7612006000000000001</IBAN></Id></Acct>
  <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
  <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1500.50</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
  <Ntry><Amt Ccy="EUR">800.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-02-03</Dt></BookgDt><AcctSvcrRef>REF1</AcctSvcrRef><NtryDtls><TxDtls><RmtInf><Ustrd>REMISE CHEQUES</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="EUR">300.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-02-04</Dt></BookgDt><AddtlNtryInf>PRLV &amp; FRAIS</AddtlNtryInf></Ntry>
  </Stmt></BkToCstmrStmt></Document>`;

  it('reads entries and balances', () => {
    const s = parseCamt053(xml);
    expect(s).toMatchObject({
      format: 'CAMT',
      accountId: 'FR7612006000000000001',
      openingCents: 100000,
      closingCents: 150050,
    });
    expect(s.transactions).toEqual([
      {
        fitid: 'REF1',
        date: '2026-02-03',
        amountCents: 80050,
        label: 'REMISE CHEQUES',
        memo: null,
      },
      { fitid: null, date: '2026-02-04', amountCents: -30000, label: 'PRLV & FRAIS', memo: null },
    ]);
  });

  it('detects the format of an uploaded file', () => {
    expect(detectAndParse(OFX).format).toBe('OFX');
    expect(detectAndParse(xml).format).toBe('CAMT');
    expect(detectAndParse('date;libelle;montant\n01/02/2026;X;1,00\n').format).toBe('CSV');
  });
});

describe('duplicates (R-CPT-12)', () => {
  it('re-importing the same file gives the same fingerprints', () => {
    const txs = parseOfx(OFX).transactions;
    expect(fingerprints(txs)).toEqual(fingerprints(parseOfx(OFX).transactions));
  });

  it('two identical payments of the same day stay distinct', () => {
    const t = { date: '2026-02-03', amountCents: -500, label: 'CARTE  CAFE' };
    const [a, b, c] = fingerprints([t, { ...t, label: 'carte cafe' }, { ...t, amountCents: -501 }]);
    expect(a).not.toBe(b);
    expect(a!.replace(/#\d+$/, '')).toBe(b!.replace(/#\d+$/, ''));
    expect(c).not.toBe(a);
  });
});

describe('assignment rules (R-CPT-13)', () => {
  const rule = (over: Partial<BankRuleLike>): BankRuleLike => ({
    priority: 10,
    pattern: 'x',
    matchType: 'CONTAINS',
    direction: 'ANY',
    minAmountCents: null,
    maxAmountCents: null,
    active: true,
    ...over,
  });
  const line = (label: string, amountCents: number, memo: string | null = null) => ({
    label,
    memo,
    amountCents,
  });

  it('contains is case and accent insensitive; starts looks at the label only', () => {
    expect(
      ruleMatches(rule({ pattern: 'ÉMIS WEB gaec' }), line('emis web GAEC des Ecureuils', -100)),
    ).toBe(true);
    expect(
      ruleMatches(rule({ matchType: 'STARTS', pattern: 'remise' }), line('REMISE CARTE', 100)),
    ).toBe(true);
    expect(
      ruleMatches(rule({ matchType: 'STARTS', pattern: 'carte' }), line('REMISE CARTE', 100)),
    ).toBe(false);
  });

  it('applies direction and amount bounds on the absolute amount', () => {
    expect(ruleMatches(rule({ pattern: 'a', direction: 'IN' }), line('a', -100))).toBe(false);
    expect(ruleMatches(rule({ pattern: 'a', direction: 'OUT' }), line('a', -100))).toBe(true);
    expect(ruleMatches(rule({ pattern: 'a', minAmountCents: 500 }), line('a', -499))).toBe(false);
    expect(ruleMatches(rule({ pattern: 'a', maxAmountCents: 500 }), line('a', -501))).toBe(false);
  });

  it('regex rules, an invalid regex never matches', () => {
    expect(
      ruleMatches(
        rule({ matchType: 'REGEX', pattern: 'FAVEUR.*EPICAFE' }),
        line('VIR FAVEUR EPICAFE', 100),
      ),
    ).toBe(true);
    expect(ruleMatches(rule({ matchType: 'REGEX', pattern: '(' }), line('(', 100))).toBe(false);
    expect(validateRegex('(')).not.toBeNull();
    expect(validateRegex('a+')).toBeNull();
  });

  it('the lowest priority number wins; inactive rules are ignored', () => {
    const rules = [
      { ...rule({ pattern: 'carte', priority: 20 }), id: 'general' },
      { ...rule({ pattern: 'remise carte', priority: 10 }), id: 'specific' },
      { ...rule({ pattern: 'remise', priority: 1, active: false }), id: 'off' },
    ];
    expect(matchRule(rules, line('REMISE CARTE', 100))?.id).toBe('specific');
    expect(matchRule(rules, line('autre', 100))).toBeNull();
  });

  it('renders the label template', () => {
    expect(
      renderLabelTemplate('Frais {libelle} du {date} ({montant})', {
        label: 'CARTE',
        date: '2026-02-03',
        amountCents: -350,
      }),
    ).toBe('Frais CARTE du 03/02/2026 (3,50)');
    expect(renderLabelTemplate(null, { label: 'X', date: '2026-02-03', amountCents: 1 })).toBe('X');
  });
});

describe('household reference (R-MBR-04, R-CPT-09)', () => {
  const households = [
    { id: 1, transferReference: 'RF544629' },
    { id: 2, transferReference: 'RF9609219321179' },
    { id: 3, transferReference: null },
    { id: 4, transferReference: 'AB1' },
  ];

  it('finds the household whose reference appears in the label, ignoring spaces and case', () => {
    expect(findHouseholdByReference('VIR SEPA REF rf 5446 29 MERCI', households)?.id).toBe(1);
    expect(findHouseholdByReference('rf9609219321179', households)?.id).toBe(2);
  });

  it('ignores short references and unknown labels', () => {
    expect(findHouseholdByReference('AB1 AB1', households)).toBeNull();
    expect(findHouseholdByReference('rien', households)).toBeNull();
  });
});

describe('reconciliation (R-CPT-14)', () => {
  it('proposes entry lines with the same amount within ±5 days, nearest first', () => {
    const lines = [
      { id: 'a', date: '2026-02-08', amountCents: -25564 },
      { id: 'b', date: '2026-02-10', amountCents: -25564 },
      { id: 'c', date: '2026-02-20', amountCents: -25564 },
      { id: 'd', date: '2026-02-10', amountCents: -25565 },
    ];
    expect(
      matchingEntryLines({ date: '2026-02-10', amountCents: -25564 }, lines).map((l) => l.id),
    ).toEqual(['b', 'a']);
  });

  it('proposes unpaid invoices of the same amount for an outgoing payment only', () => {
    const invoices = [
      { id: 1, totalCents: 25564, dueDate: '2026-02-28' },
      { id: 2, totalCents: 25564, dueDate: '2026-02-11' },
    ];
    expect(
      matchingInvoices({ date: '2026-02-10', amountCents: -25564 }, invoices).map((i) => i.id),
    ).toEqual([2, 1]);
    expect(matchingInvoices({ date: '2026-02-10', amountCents: 25564 }, invoices)).toEqual([]);
  });

  it('the statement closes only with a zero gap', () => {
    expect(statementGapCents(100000, 123456, [3000, -25564, 46020])).toBe(0);
    expect(statementGapCents(100000, 123456, [3000])).toBe(20456);
  });
});

describe('automatic matching (R-CPT-13/14)', () => {
  it('pre-assigns a line only when the suggestion is unique', () => {
    expect(autoMatchPick([])).toBeNull();
    expect(autoMatchPick([{ kind: 'INVOICE' }])).toEqual({ kind: 'INVOICE' });
    expect(autoMatchPick([{ kind: 'ENTRY_LINE' }, { kind: 'ENTRY_LINE' }])).toBeNull();
    expect(autoMatchPick([{ kind: 'RULE' }, { kind: 'INVOICE' }])).toBeNull();
  });
});

describe('rule suggestions (R-CPT-13)', () => {
  const m = (label: string, amountCents: number, acc = 'a-607') => ({
    label,
    amountCents,
    counterAccountId: acc,
    counterAccount: acc === 'a-607' ? '607000' : '627100',
  });
  it('proposes a rule after three identical manual assignments', () => {
    const s = suggestRules(
      [
        m('PRLV SEPA GAEC DES ECUREUILS 0412', -1000),
        m('PRLV SEPA GAEC DES ECUREUILS 0512', -1200),
        m('PRLV SEPA GAEC DES ECUREUILS 0612', -900),
        m('CB LECLERC', -500),
      ],
      [],
    );
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      pattern: 'prlv sepa',
      direction: 'OUT',
      counterAccount: '607000',
      count: 3,
    });
  });
  it('needs the same account every time, enough occurrences and no covering rule', () => {
    const lines = [m('FRAIS CB', -100), m('FRAIS CB', -100), m('FRAIS CB', -100, 'a-627')];
    expect(suggestRules(lines, [])).toEqual([]);
    expect(suggestRules(lines.slice(0, 2), [])).toEqual([]);
    const three = [m('FRAIS CB', -100), m('FRAIS CB', -100), m('FRAIS CB', -100)];
    expect(suggestRules(three, [])).toHaveLength(1);
    const rule: BankRuleLike = {
      priority: 1,
      pattern: 'frais',
      matchType: 'CONTAINS',
      direction: 'ANY',
      minAmountCents: null,
      maxAmountCents: null,
      active: true,
    };
    expect(suggestRules(three, [rule])).toEqual([]);
  });
});
