import { entryModeFromLegacy, type EntryModeCode as EntryMode } from '@episoft/shared';
import { legacyCents } from './transform-lot1';

// Pure transformations for the accounting part of the legacy migration (spec §9.1 step 8,
// mapping §6 "epicompta"). No database access here; lot3.ts applies them.

export type NormalSide = 'D' | 'C' | 'M';

export function accountSide(type: string | null | undefined): NormalSide {
  const t = (type ?? '').trim().toUpperCase();
  return t === 'C' || t === 'D' ? t : 'M';
}

/** Legacy MVTRGLT 0–5 → payment mode. */
export function entryModeOf(rglt: number | null | undefined): EntryMode | null {
  return entryModeFromLegacy(rglt ?? null);
}

/**
 * Accounts have 6 digits in v2. The guides still hold some 8-digit numbers (61500000…): the
 * first six digits are kept when that account exists. The old bank sub-account 51211000 has
 * no equivalent and maps to the bank account.
 */
export function sixDigitAccount(
  raw: number | string,
  known: ReadonlySet<string>,
  bankAccount: string,
): string | null {
  const digits = String(raw).trim();
  if (/^\d{6}$/.test(digits)) return digits;
  if (/^\d{8}$/.test(digits)) {
    const short = digits.slice(0, 6);
    if (known.has(short)) return short;
    if (short.startsWith('512')) return bankAccount;
  }
  return null;
}

export interface LegacyLine {
  account: number;
  label: string;
  debit: number | string | null;
  credit: number | string | null;
}

export interface PlannedLine {
  account: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

/**
 * Lines of one legacy movement in cents. A line carrying both a debit and a credit (seen in
 * the old data) is split in two so that every v2 line has one side only; empty lines are dropped.
 * A negative amount (credit notes were keyed as negative invoices) moves to the opposite side.
 */
export function planLines(lines: LegacyLine[]): PlannedLine[] {
  const out: PlannedLine[] = [];
  for (const l of lines) {
    const label = (l.label ?? '').trim();
    const debit = legacyCents(l.debit);
    const credit = legacyCents(l.credit);
    const debitCents = Math.max(debit, 0) + Math.max(-credit, 0);
    const creditCents = Math.max(credit, 0) + Math.max(-debit, 0);
    const account = String(l.account);
    if (debitCents > 0) out.push({ account, label, debitCents, creditCents: 0 });
    if (creditCents > 0) out.push({ account, label, debitCents: 0, creditCents });
  }
  return out;
}

export const hasNegativeAmount = (lines: readonly LegacyLine[]) =>
  lines.some((l) => legacyCents(l.debit) < 0 || legacyCents(l.credit) < 0);

export function lineDifference(lines: readonly PlannedLine[]): number {
  return lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
}

export interface YearSpec {
  label: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
}

/** Calendar year of a date; past years are closed, the current one stays open. */
export function calendarYear(date: string, today: string): YearSpec {
  const y = date.slice(0, 4);
  return {
    label: `Exercice ${y}`,
    startDate: `${y}-01-01`,
    endDate: `${y}-12-31`,
    status: Number(y) < Number(today.slice(0, 4)) ? 'CLOSED' : 'OPEN',
  };
}

export interface MovementKey {
  mvtnum: number;
  date: string;
  journal: string;
  fiscalYear: string;
}

/**
 * Entry numbers of the validated movements: continuous per journal and fiscal year, in date then
 * legacy-number order (R-CPT-05).
 */
export function numberMovements(rows: readonly MovementKey[]): Map<number, number> {
  const out = new Map<number, number>();
  const groups = new Map<string, MovementKey[]>();
  for (const r of rows) {
    const k = `${r.journal}|${r.fiscalYear}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const group of groups.values()) {
    group
      .sort((a, b) => a.date.localeCompare(b.date) || a.mvtnum - b.mvtnum)
      .forEach((r, i) => out.set(r.mvtnum, i + 1));
  }
  return out;
}

export interface ParsedRule {
  priority: number;
  debitAccount: string;
  creditAccount: string;
  mode: EntryMode | null;
  text: string;
  /** IN when the bank account is debited, OUT when it is credited. */
  direction: 'IN' | 'OUT';
  counterAccount: string;
}

/**
 * `Models.txt`: `CpteDeb,CpteCre,RgltMode,StartLibPos=TextToFind`, first matching line wins, so
 * the file order becomes the priority. The "start position" is dropped: the text is matched
 * anywhere in the label.
 */
export function parseModels(text: string, bankAccount: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const lines = text.split(/\r?\n/).slice(1);
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const m = /^\s*(\d{6}),(\d{6}),(\d),(\d+)=(.*)$/.exec(raw);
    if (!m) continue;
    const [, debit, credit, mode, , pattern] = m;
    const trimmed = pattern!.trim();
    if (!trimmed) continue;
    const bankDebited = debit!.startsWith('512');
    rules.push({
      priority: (rules.length + 1) * 10,
      debitAccount: debit!,
      creditAccount: credit!,
      mode: entryModeOf(Number(mode)),
      text: trimmed,
      direction: bankDebited ? 'IN' : 'OUT',
      counterAccount: bankDebited ? credit! : debit!,
    });
  }
  return rules.map((r) => ({
    ...r,
    // Any other 512 account is the same bank for the rules that mention a bank sub-account.
    counterAccount: r.counterAccount.startsWith('512') ? bankAccount : r.counterAccount,
  }));
}

export interface InvoiceCandidate {
  id: string;
  supplierAccount: string | null;
  date: string;
  totalCents: number;
}

export interface MovementCandidate {
  mvtnum: number;
  date: string;
  /** Supplier (401…) line amounts for this movement: credit for an invoice, debit for a payment. */
  supplierAccount: string;
  cents: number;
}

const dayDiff = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Links migrated ACH entries to the supplier invoices already in the database (so the
 * application does not generate a second entry): same supplier account and amount, closest date
 * within `maxDays`. Each invoice and each movement is used once; ambiguous ties are left out.
 */
export function matchInvoices(
  movements: readonly MovementCandidate[],
  invoices: readonly InvoiceCandidate[],
  maxDays = 60,
): { pairs: { mvtnum: number; invoiceId: string }[]; unmatched: number[] } {
  const usedInvoices = new Set<string>();
  const pairs: { mvtnum: number; invoiceId: string }[] = [];
  const unmatched: number[] = [];
  for (const mv of [...movements].sort((a, b) => a.date.localeCompare(b.date))) {
    const candidates = invoices
      .filter(
        (i) =>
          !usedInvoices.has(i.id) &&
          i.supplierAccount === mv.supplierAccount &&
          i.totalCents === mv.cents &&
          dayDiff(i.date, mv.date) <= maxDays,
      )
      .map((i) => ({ i, d: dayDiff(i.date, mv.date) }))
      .sort((a, b) => a.d - b.d);
    const best = candidates[0];
    if (!best || (candidates[1] && candidates[1].d === best.d)) {
      unmatched.push(mv.mvtnum);
      continue;
    }
    usedInvoices.add(best.i.id);
    pairs.push({ mvtnum: mv.mvtnum, invoiceId: best.i.id });
  }
  return { pairs, unmatched };
}
