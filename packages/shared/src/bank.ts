import { normalizeSearch } from './text';
import { addDays } from './pos';

// Bank statements (spec §4.11 R-CPT-12..15): parsers, duplicate detection, assignment rules
// and reconciliation candidates. Pure functions on integer cents.

export interface ParsedTx {
  /** Bank transaction id; null when the format has none (CSV). */
  fitid: string | null;
  /** YYYY-MM-DD. */
  date: string;
  /** Signed: positive is money in (R-CPT-12: the sign gives the direction). */
  amountCents: number;
  /** Kept as received: no case conversion. */
  label: string;
  memo: string | null;
}

export interface ParsedStatement {
  format: 'OFX' | 'CSV' | 'CAMT';
  accountId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  openingCents: number | null;
  closingCents: number | null;
  transactions: ParsedTx[];
}

export class BankParseError extends Error {}

// --- Amounts and dates ------------------------------------------------------------------

/** "1 234,56", "-12.5", "12,50 €" → cents; null when it is not a number. */
export function parseBankAmount(input: string): number | null {
  const s = input.replace(/[\s  €]/g, '');
  const m = /^([+-])?(\d+)(?:[.,](\d{1,2})\d*)?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

/** "20260105120000[0:GMT]", "2026-01-05", "05/01/2026", "05-01-26" → YYYY-MM-DD. */
export function parseBankDate(input: string): string | null {
  const s = input.trim();
  let m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (m && s.length >= 8 && !s.includes('-') && !s.includes('/')) return valid(m[1]!, m[2]!, m[3]!);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return valid(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m)
    return valid(
      m[3]!.length === 2 ? `20${m[3]}` : m[3]!,
      m[2]!.padStart(2, '0'),
      m[1]!.padStart(2, '0'),
    );
  return null;
}

function valid(y: string, mo: string, d: string): string | null {
  const t = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`
    ? null
    : `${y}-${mo}-${d}`;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

// --- OFX ------------------------------------------------------------------------------------

/** OFX 1.x (SGML, closing tags optional) and 2.x (XML). */
export function parseOfx(text: string): ParsedStatement {
  const tag = (block: string, name: string): string | null => {
    const m = new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i').exec(block);
    return m ? decodeXml(m[1]!.trim()) : null;
  };
  const blocks = [
    ...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi),
  ].map((m) => m[1]!);
  if (!blocks.length && !/<OFX/i.test(text))
    throw new BankParseError('Ce fichier n’est pas un relevé OFX.');
  const transactions: ParsedTx[] = blocks.map((b, i) => {
    const date = parseBankDate(tag(b, 'DTPOSTED') ?? '');
    const amount = parseBankAmount(tag(b, 'TRNAMT') ?? '');
    if (!date || amount === null)
      throw new BankParseError(`Transaction ${i + 1} illisible (date ou montant).`);
    const name = tag(b, 'NAME') ?? '';
    const memo = tag(b, 'MEMO');
    return {
      fitid: tag(b, 'FITID'),
      date,
      amountCents: amount,
      label: name || memo || '',
      memo: name ? memo : null,
    };
  });
  const ledger = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|$)/i.exec(text)?.[1] ?? '';
  const balance = parseBankAmount(tag(ledger, 'BALAMT') ?? '');
  const sum = transactions.reduce((s, t) => s + t.amountCents, 0);
  const closing = balance;
  return {
    format: 'OFX',
    accountId: tag(text, 'ACCTID'),
    periodStart: parseBankDate(tag(text, 'DTSTART') ?? ''),
    periodEnd: parseBankDate(tag(text, 'DTEND') ?? ''),
    openingCents: closing === null ? null : closing - sum,
    closingCents: closing,
    transactions,
  };
}

// --- CSV --------------------------------------------------------------------------------------

function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS = {
  date: ['date', 'date operation', 'date de l operation', 'date comptable', 'date de valeur'],
  label: ['libelle', 'libelle de l operation', 'label', 'description', 'intitule', 'objet'],
  amount: ['montant', 'amount', 'montant eur'],
  debit: ['debit', 'debit eur'],
  credit: ['credit', 'credit eur'],
  memo: ['memo', 'detail', 'complement', 'reference'],
} as const;

/** CSV with a header line: date, label and either one signed amount or debit/credit columns. */
export function parseCsv(text: string): ParsedStatement {
  const clean = text.replace(/^﻿/, '');
  const first = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', '\t', ','].sort(
    (a, b) => first.split(b).length - first.split(a).length,
  )[0]!;
  const rows = splitCsv(clean, delimiter);
  const header = rows[0]?.map((h) =>
    normalizeSearch(h)
      .replace(/[^a-z0-9]+/g, ' ')
      .trim(),
  );
  if (!header) throw new BankParseError('Fichier CSV vide.');
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const iDate = col(HEADERS.date);
  const iLabel = col(HEADERS.label);
  const iAmount = col(HEADERS.amount);
  const iDebit = col(HEADERS.debit);
  const iCredit = col(HEADERS.credit);
  const iMemo = col(HEADERS.memo);
  if (iDate < 0 || iLabel < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0)) {
    throw new BankParseError('Colonnes attendues : date, libellé et montant (ou débit et crédit).');
  }
  const transactions: ParsedTx[] = rows.slice(1).map((r, i) => {
    const date = parseBankDate(r[iDate] ?? '');
    let amount: number | null;
    if (iAmount >= 0) amount = parseBankAmount(r[iAmount] ?? '');
    else {
      const d = (r[iDebit] ?? '').trim() ? parseBankAmount(r[iDebit]!) : 0;
      const c = (r[iCredit] ?? '').trim() ? parseBankAmount(r[iCredit]!) : 0;
      amount = d === null || c === null ? null : Math.abs(c) - Math.abs(d);
    }
    if (!date || amount === null)
      throw new BankParseError(`Ligne ${i + 2} illisible (date ou montant).`);
    return {
      fitid: null,
      date,
      amountCents: amount,
      label: (r[iLabel] ?? '').trim(),
      memo: iMemo >= 0 ? (r[iMemo] ?? '').trim() || null : null,
    };
  });
  const dates = transactions.map((t) => t.date).sort();
  return {
    format: 'CSV',
    accountId: null,
    periodStart: dates[0] ?? null,
    periodEnd: dates.at(-1) ?? null,
    openingCents: null,
    closingCents: null,
    transactions,
  };
}

// --- CAMT.053 ----------------------------------------------------------------------------------

/** ISO 20022 bank-to-customer statement (camt.053), without an XML dependency. */
export function parseCamt053(xml: string): ParsedStatement {
  if (!/<BkToCstmrStmt/i.test(xml))
    throw new BankParseError('Ce fichier n’est pas un relevé CAMT.053.');
  const inner = (s: string, tagName: string) => {
    const m = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i').exec(s);
    return m ? decodeXml(m[1]!.trim()) : null;
  };
  const signed = (block: string): number | null => {
    const amt = parseBankAmount(inner(block, 'Amt') ?? '');
    if (amt === null) return null;
    return inner(block, 'CdtDbtInd')?.toUpperCase() === 'DBIT' ? -Math.abs(amt) : Math.abs(amt);
  };
  const transactions: ParsedTx[] = [...xml.matchAll(/<Ntry>([\s\S]*?)<\/Ntry>/gi)].map((m, i) => {
    const b = m[1]!;
    const date = parseBankDate(
      inner(inner(b, 'BookgDt') ?? '', 'Dt') ?? inner(inner(b, 'BookgDt') ?? '', 'DtTm') ?? '',
    );
    const amount = signed(b);
    if (!date || amount === null)
      throw new BankParseError(`Écriture ${i + 1} illisible (date ou montant).`);
    const ustrd = [...b.matchAll(/<Ustrd>([\s\S]*?)<\/Ustrd>/gi)]
      .map((u) => decodeXml(u[1]!.trim()))
      .join(' ');
    const info = inner(b, 'AddtlNtryInf');
    return {
      fitid: inner(b, 'AcctSvcrRef') ?? inner(b, 'NtryRef'),
      date,
      amountCents: amount,
      label: ustrd || info || inner(b, 'Nm') || '',
      memo: ustrd && info ? info : null,
    };
  });
  const balance = (code: string): number | null => {
    for (const m of xml.matchAll(/<Bal>([\s\S]*?)<\/Bal>/gi)) {
      if (new RegExp(`<Cd>${code}</Cd>`, 'i').test(m[1]!)) return signed(m[1]!);
    }
    return null;
  };
  const dates = transactions.map((t) => t.date).sort();
  return {
    format: 'CAMT',
    accountId: inner(inner(xml, 'Acct') ?? '', 'IBAN') ?? inner(xml, 'Id'),
    periodStart: dates[0] ?? null,
    periodEnd: dates.at(-1) ?? null,
    openingCents: balance('OPBD'),
    closingCents: balance('CLBD'),
    transactions,
  };
}

export function detectAndParse(text: string): ParsedStatement {
  const head = text.slice(0, 2000);
  if (/<OFX|OFXHEADER/i.test(head)) return parseOfx(text);
  if (/<BkToCstmrStmt|<Document[^>]*camt\.053/i.test(text)) return parseCamt053(text);
  return parseCsv(text);
}

// --- Duplicates (R-CPT-12) -------------------------------------------------------------------

/**
 * date + amount + label, with an occurrence number so two genuinely identical payments of
 * the same day in one file are both kept, while re-importing the file adds nothing.
 */
export function fingerprints(
  txs: readonly Pick<ParsedTx, 'date' | 'amountCents' | 'label'>[],
): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const base = `${t.date}|${t.amountCents}|${t.label.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}

// --- Assignment rules (R-CPT-13) ---------------------------------------------------------------

export const RULE_MATCH_TYPES = ['CONTAINS', 'STARTS', 'REGEX'] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];
export type RuleDirection = 'IN' | 'OUT' | 'ANY';

export interface BankRuleLike {
  priority: number;
  pattern: string;
  matchType: RuleMatchType;
  direction: RuleDirection;
  /** Bounds on the absolute amount, in cents. */
  minAmountCents: number | null;
  maxAmountCents: number | null;
  active: boolean;
}

export function ruleMatches(
  rule: BankRuleLike,
  line: { label: string; memo: string | null; amountCents: number },
): boolean {
  if (!rule.active) return false;
  if (rule.direction === 'IN' && line.amountCents <= 0) return false;
  if (rule.direction === 'OUT' && line.amountCents >= 0) return false;
  const abs = Math.abs(line.amountCents);
  if (rule.minAmountCents !== null && abs < rule.minAmountCents) return false;
  if (rule.maxAmountCents !== null && abs > rule.maxAmountCents) return false;
  const text = `${line.label} ${line.memo ?? ''}`.trim();
  switch (rule.matchType) {
    case 'CONTAINS':
      return normalizeSearch(text).includes(normalizeSearch(rule.pattern));
    case 'STARTS':
      return normalizeSearch(line.label).startsWith(normalizeSearch(rule.pattern));
    case 'REGEX':
      try {
        return new RegExp(rule.pattern, 'i').test(text);
      } catch {
        return false;
      }
  }
}

/** First rule by explicit priority (lower first), then by id order of the array. */
export function matchRule<R extends BankRuleLike>(
  rules: readonly R[],
  line: { label: string; memo: string | null; amountCents: number },
): R | null {
  return (
    [...rules].sort((a, b) => a.priority - b.priority).find((r) => ruleMatches(r, line)) ?? null
  );
}

export function validateRegex(pattern: string): string | null {
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Expression invalide.';
  }
}

export function renderLabelTemplate(
  template: string | null,
  line: { label: string; date: string; amountCents: number },
): string {
  const t = template && template.trim() ? template : '{libelle}';
  const amount = `${Math.floor(Math.abs(line.amountCents) / 100)},${String(Math.abs(line.amountCents) % 100).padStart(2, '0')}`;
  return t
    .replaceAll('{libelle}', line.label)
    .replaceAll('{date}', line.date.split('-').reverse().join('/'))
    .replaceAll('{montant}', amount);
}

// --- Household transfer reference (R-MBR-04, R-CPT-09) -------------------------------------------

const compactRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The household whose transfer reference appears in the label (at least 6 characters). */
export function findHouseholdByReference<H extends { transferReference: string | null }>(
  text: string,
  households: readonly H[],
): H | null {
  const haystack = compactRef(text);
  const found = households.filter((h) => {
    const r = h.transferReference ? compactRef(h.transferReference) : '';
    return r.length >= 6 && haystack.includes(r);
  });
  return found.length === 1 ? found[0]! : null;
}

// --- Reconciliation candidates (R-CPT-14) ----------------------------------------------------------

export interface BankLineLike {
  date: string;
  amountCents: number;
}

export interface EntryLineLike {
  id: string;
  date: string;
  /** debit − credit on the 512 account: positive is money in. */
  amountCents: number;
}

const dayDiff = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Same amount, date within ±`days` (default 5), nearest first. */
export function matchingEntryLines<E extends EntryLineLike>(
  line: BankLineLike,
  candidates: readonly E[],
  days = 5,
): E[] {
  return candidates
    .filter((c) => c.amountCents === line.amountCents && dayDiff(c.date, line.date) <= days)
    .sort((a, b) => dayDiff(a.date, line.date) - dayDiff(b.date, line.date));
}

/** Outgoing payment equal to an unpaid invoice (TTC), nearest to its due date first. */
export function matchingInvoices<I extends { totalCents: number; dueDate: string }>(
  line: BankLineLike,
  invoices: readonly I[],
): I[] {
  if (line.amountCents >= 0) return [];
  return invoices
    .filter((i) => i.totalCents === -line.amountCents)
    .sort((a, b) => dayDiff(a.dueDate, line.date) - dayDiff(b.dueDate, line.date));
}

/** R-CPT-14 step 4: the statement closes only when its lines explain the balance change. */
export function statementGapCents(
  openingCents: number,
  closingCents: number,
  reconciledAmounts: readonly number[],
): number {
  return closingCents - openingCents - reconciledAmounts.reduce((s, a) => s + a, 0);
}

export { addDays };
