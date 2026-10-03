import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
  account,
  entry,
  entryLine,
  fiscalYear,
  journal,
  numberCounter,
  supplier,
  type DbOrTx,
  type Tx,
} from '@episoft/db';
import {
  centsToDecimal,
  checkEntry,
  decimalToCents,
  defaultNormalSide,
  formatEntryNumber,
  reverseLines,
  type AccountBalance,
  type AccountMap,
  type PlannedLine,
} from '@episoft/shared';
import { toParisDate } from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';

export type EntryMode = (typeof entry.$inferInsert)['mode'];

export async function accountMap(db: DbOrTx): Promise<AccountMap> {
  return (await loadSettings(db))['accounting.accounts'];
}

/** The account with this number, created when missing (suppliers, imports). */
export async function ensureAccount(tx: DbOrTx, number: string, label: string) {
  const [existing] = await tx.select().from(account).where(eq(account.number, number));
  if (existing) return existing;
  const [created] = await tx
    .insert(account)
    .values({ number, label, normalSide: defaultNormalSide(number) })
    .returning();
  return created!;
}

export async function journalByCode(tx: DbOrTx, code: string) {
  const [j] = await tx.select().from(journal).where(eq(journal.code, code));
  if (!j) throw badRequest(`Journal ${code} inconnu.`);
  return j;
}

export async function fiscalYearAt(tx: DbOrTx, date: string) {
  const [y] = await tx
    .select()
    .from(fiscalYear)
    .where(and(lte(fiscalYear.startDate, date), gte(fiscalYear.endDate, date)));
  return y ?? null;
}

/**
 * The fiscal year of a date. Automatic entries create the calendar year when none exists and
 * the date is close to today; a mistyped date never creates a year (R-CPT-03).
 */
export async function fiscalYearFor(tx: Tx, date: string, autoCreate: boolean) {
  const existing = await fiscalYearAt(tx, date);
  if (existing) return existing;
  const year = Number(date.slice(0, 4));
  const thisYear = Number(toParisDate(new Date()).slice(0, 4));
  if (!autoCreate || Math.abs(year - thisYear) > 1) {
    throw badRequest(
      `Aucun exercice ne couvre le ${date.split('-').reverse().join('/')}. Créez l’exercice dans Comptabilité › Exercices.`,
    );
  }
  const [y] = await tx
    .insert(fiscalYear)
    .values({ label: `Exercice ${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` })
    .returning();
  return y!;
}

export interface NewEntry {
  journalCode?: string;
  journalId?: string;
  date: string;
  pieceRef?: string | null;
  label: string;
  mode?: EntryMode | null;
  lines: NewEntryLine[];
  source?: { type: string; id: string };
  userId: string | null;
  autoFiscalYear?: boolean;
}

/** A line by account number (automatic entries) or by account id (the entry form). */
export interface NewEntryLine {
  account?: string;
  accountId?: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

/**
 * Creates a draft entry after every check of R-CPT-04: an open fiscal year, existing
 * accounts, debit XOR credit, balanced to the cent. Returns the entry id.
 */
export async function createEntry(tx: Tx, e: NewEntry): Promise<string> {
  const j = e.journalId
    ? (await tx.select().from(journal).where(eq(journal.id, e.journalId)))[0]
    : await journalByCode(tx, e.journalCode!);
  if (!j) throw badRequest('Journal inconnu.');
  const fy = await fiscalYearFor(tx, e.date, e.autoFiscalYear ?? false);
  if (fy.status !== 'OPEN') throw conflict(`L’exercice ${fy.label} est clôturé.`);

  const numbers = e.lines.map((l) => l.account).filter((n): n is string => !!n);
  const ids = e.lines.map((l) => l.accountId).filter((n): n is string => !!n);
  const accounts = [
    ...(numbers.length
      ? await tx.select().from(account).where(inArray(account.number, numbers))
      : []),
    ...(ids.length ? await tx.select().from(account).where(inArray(account.id, ids)) : []),
  ];
  const resolved = e.lines.map((l) => {
    const a = l.account
      ? accounts.find((x) => x.number === l.account)
      : accounts.find((x) => x.id === l.accountId);
    return { a, l };
  });
  const check = checkEntry(
    resolved.map(({ a, l }) => ({
      accountId: a?.id ?? null,
      label: l.label,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
    })),
  );
  if (check.errors.length)
    throw badRequest(
      check.errors[0]!,
      check.errors.map((m) => ({ path: 'lines', message: m })),
    );
  const inactive = resolved.find(({ a }) => a && !a.active);
  if (inactive) throw badRequest(`Le compte ${inactive.a!.number} est désactivé.`);

  const [created] = await tx
    .insert(entry)
    .values({
      journalId: j.id,
      fiscalYearId: fy.id,
      date: e.date,
      pieceRef: e.pieceRef?.trim() || null,
      label: e.label,
      mode: e.mode ?? null,
      sourceType: e.source?.type ?? null,
      sourceId: e.source?.id ?? null,
      createdBy: e.userId,
    })
    .returning({ id: entry.id });
  await tx.insert(entryLine).values(
    resolved.map(({ a, l }, i) => ({
      entryId: created!.id,
      lineNo: i + 1,
      accountId: a!.id,
      label: l.label,
      debit: centsToDecimal(l.debitCents),
      credit: centsToDecimal(l.creditCents),
    })),
  );
  return created!.id;
}

export function plannedToLines(lines: readonly PlannedLine[]) {
  return lines.map((l) => ({
    account: l.account,
    label: l.label,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
  }));
}

/** Replaces the content of a draft entry (R-CPT-04 checks again). */
export async function replaceDraftLines(
  tx: Tx,
  entryId: string,
  lines: readonly { accountId: string; label: string; debitCents: number; creditCents: number }[],
) {
  const check = checkEntry(lines);
  if (check.errors.length)
    throw badRequest(
      check.errors[0]!,
      check.errors.map((m) => ({ path: 'lines', message: m })),
    );
  const found = await tx
    .select({ id: account.id, active: account.active, number: account.number })
    .from(account)
    .where(
      inArray(
        account.id,
        lines.map((l) => l.accountId),
      ),
    );
  for (const l of lines)
    if (!found.some((f) => f.id === l.accountId)) throw badRequest('Compte inconnu.');
  await tx.delete(entryLine).where(eq(entryLine.entryId, entryId));
  await tx.insert(entryLine).values(
    lines.map((l, i) => ({
      entryId,
      lineNo: i + 1,
      accountId: l.accountId,
      label: l.label,
      debit: centsToDecimal(l.debitCents),
      credit: centsToDecimal(l.creditCents),
    })),
  );
}

export async function entryBySource(tx: DbOrTx, type: string, id: string) {
  const [e] = await tx
    .select()
    .from(entry)
    .where(and(eq(entry.sourceType, type), eq(entry.sourceId, id)));
  return e ?? null;
}

/**
 * R-CPT-05: validation fixes the entry. Numbers are given here, in date then creation order,
 * per journal and fiscal year, so the numbering is continuous (§5.7).
 */
export async function validateEntries(
  tx: Tx,
  ids: string[],
  userId: string,
): Promise<{ validated: number; numbers: string[] }> {
  if (!ids.length) return { validated: 0, numbers: [] };
  // Lock the drafts first (a plain FOR UPDATE: no join, so no other table is locked).
  await tx
    .select({ id: entry.id })
    .from(entry)
    .where(and(inArray(entry.id, ids), eq(entry.status, 'DRAFT')))
    .for('update');
  const rows = await tx
    .select({
      e: entry,
      journalCode: journal.code,
      yearStatus: fiscalYear.status,
      yearStart: fiscalYear.startDate,
    })
    .from(entry)
    .innerJoin(journal, eq(journal.id, entry.journalId))
    .innerJoin(fiscalYear, eq(fiscalYear.id, entry.fiscalYearId))
    .where(and(inArray(entry.id, ids), eq(entry.status, 'DRAFT')))
    .orderBy(asc(entry.date), asc(entry.createdAt), asc(entry.id));
  const numbers: string[] = [];
  for (const r of rows) {
    if (r.yearStatus !== 'OPEN') throw conflict('L’exercice de cette écriture est clôturé.');
    const check = await entryCheck(tx, r.e.id);
    if (!check.balanced || check.errors.length)
      throw conflict(`Écriture « ${r.e.label} » : ${check.errors[0] ?? 'déséquilibrée'}`);
    const year = Number(r.yearStart.slice(0, 4));
    const key = `entry:${r.e.journalId}:${r.e.fiscalYearId}`;
    const [counter] = await tx
      .insert(numberCounter)
      .values({ key, value: 1 })
      .onConflictDoUpdate({
        target: numberCounter.key,
        set: { value: sql`${numberCounter.value} + 1` },
      })
      .returning({ value: numberCounter.value });
    await tx
      .update(entry)
      .set({
        status: 'VALIDATED',
        number: counter!.value,
        validatedAt: new Date(),
        validatedBy: userId,
      })
      .where(eq(entry.id, r.e.id));
    numbers.push(formatEntryNumber(r.journalCode, year, counter!.value));
  }
  return { validated: rows.length, numbers };
}

export async function entryCheck(db: DbOrTx, entryId: string) {
  const lines = await db.select().from(entryLine).where(eq(entryLine.entryId, entryId));
  return checkEntry(
    lines.map((l) => ({
      accountId: l.accountId,
      label: l.label,
      debitCents: decimalToCents(l.debit),
      creditCents: decimalToCents(l.credit),
    })),
  );
}

/** Counter entry of a validated one, validated at once (R-CPT-05). */
export async function reverseEntry(
  tx: Tx,
  entryId: string,
  opts: { date?: string; label?: string; userId: string; source?: { type: string; id: string } },
): Promise<string> {
  const [orig] = await tx.select().from(entry).where(eq(entry.id, entryId));
  if (!orig) throw notFound('Écriture introuvable.');
  if (orig.status !== 'VALIDATED')
    throw conflict(
      'Seule une écriture validée se contre-passe : modifiez ou supprimez un brouillon.',
    );
  const [already] = await tx
    .select({ id: entry.id })
    .from(entry)
    .where(eq(entry.reversesEntryId, entryId));
  if (already) throw conflict('Cette écriture a déjà été contre-passée.');
  const lines = await tx
    .select()
    .from(entryLine)
    .where(eq(entryLine.entryId, entryId))
    .orderBy(entryLine.lineNo);
  const date = opts.date ?? toParisDate(new Date());
  const fy = await fiscalYearFor(tx, date, false);
  if (fy.status !== 'OPEN') throw conflict(`L’exercice ${fy.label} est clôturé.`);
  const swapped = reverseLines(
    lines.map((l) => ({
      accountId: l.accountId,
      label: l.label,
      debitCents: decimalToCents(l.debit),
      creditCents: decimalToCents(l.credit),
    })),
  );
  const [created] = await tx
    .insert(entry)
    .values({
      journalId: orig.journalId,
      fiscalYearId: fy.id,
      date,
      pieceRef: orig.pieceRef,
      label: opts.label ?? `Contre-passation : ${orig.label}`,
      mode: orig.mode,
      sourceType: opts.source?.type ?? null,
      sourceId: opts.source?.id ?? null,
      reversesEntryId: orig.id,
      createdBy: opts.userId,
    })
    .returning({ id: entry.id });
  await tx.insert(entryLine).values(
    swapped.map((l, i) => ({
      entryId: created!.id,
      lineNo: i + 1,
      accountId: l.accountId!,
      label: l.label,
      debit: centsToDecimal(l.debitCents),
      credit: centsToDecimal(l.creditCents),
    })),
  );
  await validateEntries(tx, [created!.id], opts.userId);
  return created!.id;
}

export interface BalanceFilter {
  fiscalYearId?: string;
  from?: string;
  to?: string;
  journalId?: string;
  accountFrom?: string;
  accountTo?: string;
  /** VALIDATED keeps only validated entries; ALL includes drafts. */
  status?: 'ALL' | 'VALIDATED';
  /** Leaves out the year-end result entry, so a closed year still shows its income statement. */
  excludeClosingResult?: boolean;
}

export function entryFilters(f: BalanceFilter): SQL[] {
  const where: SQL[] = [];
  if (f.fiscalYearId) where.push(eq(entry.fiscalYearId, f.fiscalYearId));
  if (f.from) where.push(gte(entry.date, f.from));
  if (f.to) where.push(lte(entry.date, f.to));
  if (f.journalId) where.push(eq(entry.journalId, f.journalId));
  if (f.status === 'VALIDATED') where.push(eq(entry.status, 'VALIDATED'));
  if (f.excludeClosingResult)
    where.push(sql`${entry.sourceType} is distinct from 'closing_result'`);
  if (f.accountFrom) where.push(gte(account.number, f.accountFrom));
  if (f.accountTo) where.push(lte(account.number, f.accountTo));
  return where;
}

/** Debit and credit totals per account (the base of the trial balance and every report). */
export async function accountBalances(db: DbOrTx, f: BalanceFilter): Promise<AccountBalance[]> {
  const rows = await db
    .select({
      number: account.number,
      label: account.label,
      debit: sql<string>`coalesce(sum(${entryLine.debit}), 0)::text`,
      credit: sql<string>`coalesce(sum(${entryLine.credit}), 0)::text`,
    })
    .from(entryLine)
    .innerJoin(entry, eq(entry.id, entryLine.entryId))
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(and(...entryFilters(f)))
    .groupBy(account.number, account.label)
    .orderBy(asc(account.number));
  return rows.map((r) => ({
    number: r.number,
    label: r.label,
    debitCents: decimalToCents(r.debit),
    creditCents: decimalToCents(r.credit),
  }));
}

/** Balance of one account up to (and including) a date, all fiscal years. */
export async function accountBalanceAt(db: DbOrTx, number: string, to: string): Promise<number> {
  const [r] = await db
    .select({
      d: sql<string>`coalesce(sum(${entryLine.debit}), 0)::text`,
      c: sql<string>`coalesce(sum(${entryLine.credit}), 0)::text`,
    })
    .from(entryLine)
    .innerJoin(entry, eq(entry.id, entryLine.entryId))
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(and(eq(account.number, number), lte(entry.date, to)));
  return decimalToCents(r!.d) - decimalToCents(r!.c);
}

/** First free 401NNN account number (R-FNR-01: created with the supplier). */
export async function nextSupplierAccountNumber(db: DbOrTx): Promise<string> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${supplier.accountNumber})` })
    .from(supplier)
    .where(sql`${supplier.accountNumber} ~ '^401[0-9]{3}$'`);
  const [acct] = await db
    .select({ max: sql<string | null>`max(${account.number})` })
    .from(account)
    .where(sql`${account.number} ~ '^401[0-9]{3}$'`);
  const top = Math.max(Number(row?.max ?? 401000), Number(acct?.max ?? 401000));
  return String(top + 1);
}

export async function entryDetail(db: DbOrTx, id: string) {
  const [e] = await db
    .select({
      e: entry,
      journalCode: journal.code,
      journalLabel: journal.label,
      yearLabel: fiscalYear.label,
      yearStart: fiscalYear.startDate,
    })
    .from(entry)
    .innerJoin(journal, eq(journal.id, entry.journalId))
    .innerJoin(fiscalYear, eq(fiscalYear.id, entry.fiscalYearId))
    .where(eq(entry.id, id));
  if (!e) return null;
  const lines = await db
    .select({
      id: entryLine.id,
      lineNo: entryLine.lineNo,
      accountId: entryLine.accountId,
      accountNumber: account.number,
      accountLabel: account.label,
      label: entryLine.label,
      debit: entryLine.debit,
      credit: entryLine.credit,
      reconciliationId: entryLine.reconciliationId,
      letteringCode: entryLine.letteringCode,
    })
    .from(entryLine)
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(eq(entryLine.entryId, id))
    .orderBy(entryLine.lineNo);
  const [reversedBy] = await db
    .select({ id: entry.id })
    .from(entry)
    .where(eq(entry.reversesEntryId, id));
  const year = Number(e.yearStart.slice(0, 4));
  return {
    ...e.e,
    createdAt: e.e.createdAt.toISOString(),
    updatedAt: e.e.updatedAt.toISOString(),
    validatedAt: e.e.validatedAt?.toISOString() ?? null,
    journalCode: e.journalCode,
    journalLabel: e.journalLabel,
    yearLabel: e.yearLabel,
    displayNumber: e.e.number !== null ? formatEntryNumber(e.journalCode, year, e.e.number) : null,
    reversedById: reversedBy?.id ?? null,
    lines,
  };
}
