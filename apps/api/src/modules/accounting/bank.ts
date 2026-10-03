import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  account,
  bankAccount,
  bankLine,
  bankRule,
  bankStatement,
  cashDeposit,
  entry,
  entryLine,
  household,
  memberPayment,
  reconciliation,
  supplier,
  supplierInvoice,
  walletEntry,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  BankParseError,
  addDays,
  bankAccountSchema,
  bankImportQuerySchema,
  bankMatchSchema,
  bankRuleSchema,
  buildBankLineEntry,
  centsToDecimal,
  decimalToCents,
  depositSchema,
  detectAndParse,
  findHouseholdByReference,
  fingerprints,
  matchRule,
  matchingEntryLines,
  matchingInvoices,
  renderLabelTemplate,
  statementGapCents,
  validateRegex,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { sendTopupReceipt } from '../pos/sync-service';
import { lockedBalanceCents } from '../pos/wallet';
import { createDeposit, payInvoice } from './auto';
import { accountBalanceAt, accountMap, createEntry, plannedToLines } from './service';

const idParams = { params: z.object({ id: z.string().uuid() }) };
const MAX_FILE = 10 * 1024 * 1024;

/** UTF-8 when the file is valid UTF-8, windows-1252 otherwise (bank exports vary). */
function decodeFile(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

async function bankInfo(tx: Db | Tx, id: string) {
  const [b] = await tx
    .select({
      id: bankAccount.id,
      label: bankAccount.label,
      accountId: bankAccount.accountId,
      number: account.number,
    })
    .from(bankAccount)
    .innerJoin(account, eq(account.id, bankAccount.accountId))
    .where(eq(bankAccount.id, id));
  if (!b) throw notFound('Compte bancaire inconnu.');
  return b;
}

/** Entry lines on the bank account not yet tied to a bank line (R-CPT-14). */
async function openBankEntryLines(db: Db | Tx, accountId: string, from: string, to: string) {
  const rows = await db
    .select({
      id: entryLine.id,
      date: entry.date,
      label: entryLine.label,
      debit: entryLine.debit,
      credit: entryLine.credit,
      entryId: entry.id,
    })
    .from(entryLine)
    .innerJoin(entry, eq(entry.id, entryLine.entryId))
    .leftJoin(bankLine, eq(bankLine.entryLineId, entryLine.id))
    .where(
      and(
        eq(entryLine.accountId, accountId),
        isNull(bankLine.id),
        isNull(entryLine.reconciliationId),
        gte(entry.date, from),
        lte(entry.date, to),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    label: r.label,
    entryId: r.entryId,
    amountCents: decimalToCents(r.debit) - decimalToCents(r.credit),
  }));
}

export const bankRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const compta = { preHandler: app.requireRoles('COMPTA') };

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_FILE },
    (_req, body, done) => done(null, body),
  );

  // --- Bank accounts ---------------------------------------------------------------------------

  app.get('/bank/accounts', compta, async () =>
    db
      .select({
        id: bankAccount.id,
        label: bankAccount.label,
        iban: bankAccount.iban,
        accountId: bankAccount.accountId,
        accountNumber: account.number,
        active: bankAccount.active,
      })
      .from(bankAccount)
      .innerJoin(account, eq(account.id, bankAccount.accountId))
      .orderBy(asc(bankAccount.label)),
  );

  app.post('/bank/accounts', { ...compta, schema: { body: bankAccountSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const [b] = await tx.insert(bankAccount).values(req.body).returning();
      await audit(tx, req, {
        action: 'bank_account.create',
        entity: 'bank_account',
        entityId: b!.id,
        after: b,
      });
      return b;
    }),
  );

  app.put(
    '/bank/accounts/:id',
    { ...compta, schema: { ...idParams, body: bankAccountSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [b] = await tx
          .update(bankAccount)
          .set(req.body)
          .where(eq(bankAccount.id, req.params.id))
          .returning();
        if (!b) throw notFound('Compte bancaire inconnu.');
        await audit(tx, req, {
          action: 'bank_account.update',
          entity: 'bank_account',
          entityId: b.id,
          after: b,
        });
        return b;
      }),
  );

  // --- Import (R-CPT-12) -------------------------------------------------------------------------

  app.post(
    '/bank/statements/import',
    { ...compta, schema: { querystring: bankImportQuerySchema } },
    async (req) => {
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0)
        throw badRequest('Fichier absent : envoyez-le en application/octet-stream.');
      const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'releve'));
      const hash = createHash('sha256').update(body).digest('hex');
      let parsed;
      try {
        parsed = detectAndParse(decodeFile(body));
      } catch (e) {
        if (e instanceof BankParseError) throw badRequest(e.message);
        throw e;
      }
      if (!parsed.transactions.length) throw badRequest('Le fichier ne contient aucune opération.');

      return db.transaction(async (tx) => {
        const bank = await bankInfo(tx, req.query.bankAccountId);
        // Serialize imports on one account so two uploads cannot both insert the same lines.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'bank:' + bank.id}))`);

        const prints = fingerprints(parsed.transactions);
        const existing = await tx
          .select({ fitid: bankLine.fitid, fingerprint: bankLine.fingerprint })
          .from(bankLine)
          .where(eq(bankLine.bankAccountId, bank.id));
        const knownFit = new Set(existing.map((e) => e.fitid).filter(Boolean));
        const knownPrint = new Set(existing.map((e) => e.fingerprint));
        const fresh = parsed.transactions
          .map((t, i) => ({ t, print: prints[i]! }))
          .filter(({ t, print }) => !(t.fitid && knownFit.has(t.fitid)) && !knownPrint.has(print));
        const duplicates = parsed.transactions.length - fresh.length;
        if (!fresh.length) return { statementId: null, inserted: 0, duplicates };

        const sum = fresh.reduce((s, { t }) => s + t.amountCents, 0);
        const typedOpening = req.query.openingBalance
          ? decimalToCents(req.query.openingBalance)
          : null;
        const typedClosing = req.query.closingBalance
          ? decimalToCents(req.query.closingBalance)
          : null;
        let opening: number;
        let closing: number;
        if (typedOpening !== null && typedClosing !== null) {
          opening = typedOpening;
          closing = typedClosing;
        } else if (parsed.closingCents !== null) {
          closing = parsed.closingCents;
          opening = closing - sum;
        } else if (typedClosing !== null) {
          closing = typedClosing;
          opening = closing - sum;
        } else if (typedOpening !== null) {
          opening = typedOpening;
          closing = opening + sum;
        } else if (parsed.openingCents !== null) {
          opening = parsed.openingCents;
          closing = opening + sum;
        } else {
          throw badRequest(
            'Ce format ne porte pas les soldes : indiquez le solde d’ouverture et de clôture.',
          );
        }

        const dates = fresh.map(({ t }) => t.date).sort();
        const [st] = await tx
          .insert(bankStatement)
          .values({
            bankAccountId: bank.id,
            fileName,
            fileHash: hash,
            format: parsed.format,
            periodStart: dates[0],
            periodEnd: dates[dates.length - 1],
            openingBalance: centsToDecimal(opening),
            closingBalance: centsToDecimal(closing),
            importedBy: req.user!.id,
          })
          .onConflictDoNothing()
          .returning();
        // The same file again: nothing to do.
        if (!st) return { statementId: null, inserted: 0, duplicates: parsed.transactions.length };
        await tx.insert(bankLine).values(
          fresh.map(({ t, print }) => ({
            statementId: st.id,
            bankAccountId: bank.id,
            fitid: t.fitid,
            fingerprint: print,
            date: t.date,
            amount: centsToDecimal(t.amountCents),
            label: t.label,
            memo: t.memo,
          })),
        );
        await audit(tx, req, {
          action: 'bank_statement.import',
          entity: 'bank_statement',
          entityId: st.id,
          after: { fileName, inserted: fresh.length, duplicates },
        });
        return { statementId: st.id, inserted: fresh.length, duplicates };
      });
    },
  );

  // --- Statements and lines ------------------------------------------------------------------------

  app.get(
    '/bank/statements',
    {
      ...compta,
      schema: { querystring: z.object({ bankAccountId: z.string().uuid().optional() }) },
    },
    async (req) => {
      const rows = await db
        .select({
          s: bankStatement,
          lines: sql<number>`(select count(*)::int from app.bank_line l where l.statement_id = ${bankStatement.id})`,
          matched: sql<number>`(select count(*)::int from app.bank_line l where l.statement_id = ${bankStatement.id} and l.status = 'MATCHED')`,
          total: sql<string>`(select coalesce(sum(amount), 0)::numeric(12,2)::text from app.bank_line l where l.statement_id = ${bankStatement.id})`,
        })
        .from(bankStatement)
        .where(
          req.query.bankAccountId
            ? eq(bankStatement.bankAccountId, req.query.bankAccountId)
            : undefined,
        )
        .orderBy(desc(bankStatement.periodEnd), desc(bankStatement.importedAt));
      return rows.map(({ s, lines, matched, total }) => ({
        id: s.id,
        bankAccountId: s.bankAccountId,
        fileName: s.fileName,
        format: s.format,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        openingBalance: s.openingBalance,
        closingBalance: s.closingBalance,
        status: s.status,
        lines,
        matched,
        gap: centsToDecimal(
          statementGapCents(decimalToCents(s.openingBalance), decimalToCents(s.closingBalance), [
            decimalToCents(total),
          ]),
        ),
      }));
    },
  );

  /** The lines of a statement with, for the new ones, the candidates of R-CPT-13/14. */
  app.get('/bank/statements/:id', { ...compta, schema: idParams }, async (req) => {
    const [st] = await db.select().from(bankStatement).where(eq(bankStatement.id, req.params.id));
    if (!st) throw notFound('Relevé introuvable.');
    const bank = await bankInfo(db, st.bankAccountId);
    const lines = await db
      .select()
      .from(bankLine)
      .where(eq(bankLine.statementId, st.id))
      .orderBy(asc(bankLine.date), asc(bankLine.id));
    const from = addDays(lines[0]?.date ?? st.periodStart ?? '1970-01-01', -5);
    const to = addDays(lines[lines.length - 1]?.date ?? st.periodEnd ?? '2999-12-31', 5);
    const candidates = await openBankEntryLines(db, bank.accountId, from, to);
    const invoices = (
      await db
        .select({
          id: supplierInvoice.id,
          pieceRef: supplierInvoice.pieceRef,
          dueDate: supplierInvoice.dueDate,
          totalIncl: supplierInvoice.totalIncl,
          supplier: supplier.name,
        })
        .from(supplierInvoice)
        .innerJoin(supplier, eq(supplier.id, supplierInvoice.supplierId))
        .where(eq(supplierInvoice.status, 'TO_PAY'))
    ).map((i) => ({ ...i, totalCents: decimalToCents(i.totalIncl) }));
    const households = await db
      .select({
        id: household.id,
        number: household.number,
        transferReference: household.transferReference,
      })
      .from(household)
      .where(sql`${household.transferReference} is not null`);
    const rules = (await db.select().from(bankRule).where(eq(bankRule.active, true))).map((r) => ({
      ...r,
      minAmountCents: r.minAmount === null ? null : decimalToCents(r.minAmount),
      maxAmountCents: r.maxAmount === null ? null : decimalToCents(r.maxAmount),
    }));

    const out = lines.map((l) => {
      const amountCents = decimalToCents(l.amount);
      const base = {
        id: l.id,
        date: l.date,
        amount: l.amount,
        label: l.label,
        memo: l.memo,
        status: l.status,
        entryLineId: l.entryLineId,
      };
      if (l.status === 'MATCHED') return { ...base, suggestions: [] };
      const lineLike = { label: l.label, memo: l.memo, amountCents };
      const suggestions: Record<string, unknown>[] = [];
      for (const c of matchingEntryLines({ date: l.date, amountCents }, candidates))
        suggestions.push({
          kind: 'ENTRY_LINE',
          entryLineId: c.id,
          entryId: c.entryId,
          label: c.label,
          date: c.date,
        });
      for (const i of matchingInvoices({ date: l.date, amountCents }, invoices))
        suggestions.push({
          kind: 'INVOICE',
          invoiceId: i.id,
          label: `${i.supplier} · ${i.pieceRef}`,
          date: i.dueDate,
        });
      if (amountCents > 0) {
        const h = findHouseholdByReference(`${l.label} ${l.memo ?? ''}`, households);
        if (h)
          suggestions.push({ kind: 'HOUSEHOLD', householdId: h.id, label: `Foyer n° ${h.number}` });
      }
      const rule = matchRule(rules, lineLike);
      if (rule) suggestions.push({ kind: 'RULE', ruleId: rule.id, label: rule.label });
      return { ...base, suggestions };
    });
    const total = lines.reduce((s, l) => s + decimalToCents(l.amount), 0);
    return {
      id: st.id,
      bankAccountId: st.bankAccountId,
      bankAccountNumber: bank.number,
      fileName: st.fileName,
      periodStart: st.periodStart,
      periodEnd: st.periodEnd,
      openingBalance: st.openingBalance,
      closingBalance: st.closingBalance,
      status: st.status,
      gap: centsToDecimal(
        statementGapCents(decimalToCents(st.openingBalance), decimalToCents(st.closingBalance), [
          total,
        ]),
      ),
      lines: out,
    };
  });

  // --- Matching (R-CPT-13, R-CPT-14, R-CPT-09) ------------------------------------------------------

  app.post('/bank/lines/match', { ...compta, schema: { body: bankMatchSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const accounts = await accountMap(tx);
      let done = 0;
      for (const item of req.body.items) {
        const [l] = await tx
          .select()
          .from(bankLine)
          .where(eq(bankLine.id, item.lineId))
          .for('update');
        if (!l) throw notFound('Ligne bancaire introuvable.');
        if (l.status !== 'NEW') throw conflict(`La ligne « ${l.label} » est déjà rapprochée.`);
        const [st] = await tx
          .select()
          .from(bankStatement)
          .where(eq(bankStatement.id, l.statementId));
        if (st!.status === 'CLOSED') throw conflict('Ce relevé est clos.');
        const bank = await bankInfo(tx, l.bankAccountId);
        const cents = decimalToCents(l.amount);
        const label = item.label ?? l.label;
        let bankEntryLineId: string;
        let ruleId: string | null = null;

        /** The bank-side line of an entry just created. */
        const bankSide = async (entryId: string) => {
          const [el] = await tx
            .select({ id: entryLine.id })
            .from(entryLine)
            .where(and(eq(entryLine.entryId, entryId), eq(entryLine.accountId, bank.accountId)));
          return el!.id;
        };

        if (item.action === 'ENTRY_LINE') {
          if (!item.entryLineId) throw badRequest('Ligne d’écriture manquante.');
          const [el] = await tx
            .select({ el: entryLine, date: entry.date })
            .from(entryLine)
            .innerJoin(entry, eq(entry.id, entryLine.entryId))
            .where(eq(entryLine.id, item.entryLineId));
          if (!el || el.el.accountId !== bank.accountId)
            throw badRequest('Cette ligne n’est pas sur le compte bancaire.');
          if (decimalToCents(el.el.debit) - decimalToCents(el.el.credit) !== cents)
            throw conflict('Les montants ne correspondent pas.');
          const [taken] = await tx
            .select({ id: bankLine.id })
            .from(bankLine)
            .where(eq(bankLine.entryLineId, item.entryLineId));
          if (taken) throw conflict('Cette écriture est déjà rapprochée.');
          bankEntryLineId = item.entryLineId;
        } else if (item.action === 'INVOICE') {
          if (!item.invoiceId) throw badRequest('Facture manquante.');
          const [inv] = await tx
            .select()
            .from(supplierInvoice)
            .where(eq(supplierInvoice.id, item.invoiceId));
          if (!inv) throw notFound('Facture introuvable.');
          if (decimalToCents(inv.totalIncl) !== -cents)
            throw conflict('Le montant de la facture ne correspond pas à la ligne bancaire.');
          const paid = await payInvoice(tx, {
            invoiceId: inv.id,
            date: l.date,
            method: 'TRANSFER',
            userId: req.user!.id,
            bankAccountNumber: bank.number,
          });
          bankEntryLineId = await bankSide(paid.entryId);
        } else if (item.action === 'HOUSEHOLD') {
          if (!item.householdId) throw badRequest('Foyer manquant.');
          if (cents <= 0) throw badRequest('Seul un virement reçu peut alimenter une cagnotte.');
          const h = await tx.query.household.findFirst({
            where: eq(household.id, item.householdId),
          });
          if (!h) throw notFound('Foyer introuvable.');
          const before = await lockedBalanceCents(tx, h.id);
          const at = new Date();
          const [pay] = await tx
            .insert(memberPayment)
            .values({
              householdId: h.id,
              date: l.date,
              amount: l.amount,
              purpose: 'TOPUP',
              method: 'TRANSFER',
              bankLineId: l.id,
              comment: l.label,
              createdBy: req.user!.id,
            })
            .returning();
          await tx.insert(walletEntry).values({
            householdId: h.id,
            at,
            amount: l.amount,
            kind: 'TOPUP',
            paymentMethod: 'TRANSFER',
            paymentId: pay!.id,
            comment: l.label,
            createdBy: req.user!.id,
          });
          const entryId = await createEntry(tx, {
            journalCode: 'BNQ',
            date: l.date,
            label: `Virement cagnotte foyer n° ${h.number}`,
            mode: 'TRANSFER',
            lines: plannedToLines(
              buildBankLineEntry({
                bankAccount: bank.number,
                counterAccount: accounts.wallet,
                amountCents: cents,
                label: `Virement cagnotte foyer n° ${h.number}`,
              }),
            ),
            source: { type: 'bank_line', id: l.id },
            userId: req.user!.id,
            autoFiscalYear: true,
          });
          bankEntryLineId = await bankSide(entryId);
          if (item.sendReceipt)
            await sendTopupReceipt(tx, h.id, h.referentMemberId, {
              at,
              amountCents: cents,
              beforeCents: before,
              method: 'TRANSFER',
            });
        } else {
          // RULE or ACCOUNT: a plain entry against a counterpart account.
          let counterId: string | null = item.accountId ?? null;
          let journalId: string | null = null;
          let mode: (typeof bankRule.$inferSelect)['mode'] = null;
          let entryLabel = label;
          if (item.action === 'RULE') {
            if (!item.ruleId) throw badRequest('Règle manquante.');
            const [rule] = await tx.select().from(bankRule).where(eq(bankRule.id, item.ruleId));
            if (!rule) throw notFound('Règle introuvable.');
            ruleId = rule.id;
            journalId = rule.journalId;
            mode = rule.mode;
            counterId = item.accountId ?? rule.counterAccountId;
            if (!counterId && rule.supplierId) {
              const [s] = await tx.select().from(supplier).where(eq(supplier.id, rule.supplierId));
              if (s?.accountNumber) {
                const [a] = await tx
                  .select()
                  .from(account)
                  .where(eq(account.number, s.accountNumber));
                counterId = a?.id ?? null;
              }
            }
            if (!item.label)
              entryLabel = renderLabelTemplate(rule.labelTemplate, {
                label: l.label,
                date: l.date,
                amountCents: cents,
              });
          }
          if (!counterId) throw badRequest(`Choisissez un compte pour « ${l.label} ».`);
          const entryId = await createEntry(tx, {
            ...(journalId ? { journalId } : { journalCode: 'BNQ' }),
            date: l.date,
            label: entryLabel,
            mode,
            lines: [
              {
                account: bank.number,
                label: entryLabel,
                debitCents: Math.max(cents, 0),
                creditCents: Math.max(-cents, 0),
              },
              {
                accountId: counterId,
                label: entryLabel,
                debitCents: Math.max(-cents, 0),
                creditCents: Math.max(cents, 0),
              },
            ],
            source: { type: 'bank_line', id: l.id },
            userId: req.user!.id,
            autoFiscalYear: true,
          });
          bankEntryLineId = await bankSide(entryId);
        }

        await tx
          .update(bankLine)
          .set({ status: 'MATCHED', entryLineId: bankEntryLineId, ruleId })
          .where(eq(bankLine.id, l.id));
        done++;
      }
      await audit(tx, req, {
        action: 'bank_line.match',
        entity: 'bank_line',
        after: { count: done },
      });
      return { matched: done };
    }),
  );

  /** Undo a match that has not been closed with its statement. */
  app.post('/bank/lines/:id/unmatch', { ...compta, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [l] = await tx
        .select()
        .from(bankLine)
        .where(eq(bankLine.id, req.params.id))
        .for('update');
      if (!l) throw notFound('Ligne bancaire introuvable.');
      const [st] = await tx.select().from(bankStatement).where(eq(bankStatement.id, l.statementId));
      if (st!.status === 'CLOSED') throw conflict('Ce relevé est clos.');
      await tx
        .update(bankLine)
        .set({ status: 'NEW', entryLineId: null, ruleId: null })
        .where(eq(bankLine.id, l.id));
      await audit(tx, req, { action: 'bank_line.unmatch', entity: 'bank_line', entityId: l.id });
      return { ok: true };
    }),
  );

  /** R-CPT-14 step 4: the statement closes when every line is matched and the gap is zero. */
  app.post('/bank/statements/:id/close', { ...compta, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [st] = await tx
        .select()
        .from(bankStatement)
        .where(eq(bankStatement.id, req.params.id))
        .for('update');
      if (!st) throw notFound('Relevé introuvable.');
      if (st.status === 'CLOSED') throw conflict('Ce relevé est déjà clos.');
      const lines = await tx.select().from(bankLine).where(eq(bankLine.statementId, st.id));
      const open = lines.filter((l) => l.status !== 'MATCHED').length;
      if (open) throw conflict(`${open} ligne(s) restent à rapprocher.`);
      const gap = statementGapCents(
        decimalToCents(st.openingBalance),
        decimalToCents(st.closingBalance),
        lines.map((l) => decimalToCents(l.amount)),
      );
      if (gap !== 0)
        throw conflict(`Écart de ${centsToDecimal(gap)} € entre le relevé et ses lignes.`);
      const [rec] = await tx
        .insert(reconciliation)
        .values({
          statementId: st.id,
          label: `Rapprochement ${st.fileName}`,
          doneBy: req.user!.id,
        })
        .returning();
      const entryLineIds = lines.map((l) => l.entryLineId).filter((x): x is string => !!x);
      if (entryLineIds.length)
        await tx
          .update(entryLine)
          .set({ reconciliationId: rec!.id })
          .where(inArray(entryLine.id, entryLineIds));
      await tx
        .update(bankStatement)
        .set({ status: 'CLOSED', closedAt: new Date(), closedBy: req.user!.id })
        .where(eq(bankStatement.id, st.id));
      await audit(tx, req, {
        action: 'bank_statement.close',
        entity: 'bank_statement',
        entityId: st.id,
      });
      return { reconciliationId: rec!.id };
    }),
  );

  /** R-CPT-15: the bank balance of the books against the last closed statement. */
  app.get(
    '/bank/check',
    {
      ...compta,
      schema: {
        querystring: z.object({
          bankAccountId: z.string().uuid(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      },
    },
    async (req) => {
      const bank = await bankInfo(db, req.query.bankAccountId);
      const ledger = await accountBalanceAt(db, bank.number, req.query.date);
      const [st] = await db
        .select()
        .from(bankStatement)
        .where(
          and(
            eq(bankStatement.bankAccountId, bank.id),
            eq(bankStatement.status, 'CLOSED'),
            lte(bankStatement.periodEnd, req.query.date),
          ),
        )
        .orderBy(desc(bankStatement.periodEnd))
        .limit(1);
      const statement = st ? decimalToCents(st.closingBalance) : null;
      // Entries on the bank account that no closed statement explains yet.
      const pending = await openBankEntryLines(db, bank.accountId, '1970-01-01', req.query.date);
      const pendingCents = pending.reduce((s, p) => s + p.amountCents, 0);
      return {
        bankAccountNumber: bank.number,
        ledger: centsToDecimal(ledger),
        statementDate: st?.periodEnd ?? null,
        statement: statement === null ? null : centsToDecimal(statement),
        pending: centsToDecimal(pendingCents),
        pendingCount: pending.length,
        // The books equal the statement once the pending entries are accounted for.
        gap: statement === null ? null : centsToDecimal(ledger - pendingCents - statement),
      };
    },
  );

  // --- Rules (R-CPT-13) -----------------------------------------------------------------------------

  const ruleValues = (b: z.infer<typeof bankRuleSchema>) => {
    if (b.matchType === 'REGEX') {
      const err = validateRegex(b.pattern);
      if (err) throw badRequest(`Expression invalide : ${err}`);
    }
    return b;
  };

  app.get('/bank/rules', compta, async () =>
    db.select().from(bankRule).orderBy(asc(bankRule.priority), asc(bankRule.label)),
  );

  app.post('/bank/rules', { ...compta, schema: { body: bankRuleSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const [r] = await tx.insert(bankRule).values(ruleValues(req.body)).returning();
      await audit(tx, req, {
        action: 'bank_rule.create',
        entity: 'bank_rule',
        entityId: r!.id,
        after: r,
      });
      return r;
    }),
  );

  app.put(
    '/bank/rules/:id',
    { ...compta, schema: { ...idParams, body: bankRuleSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [r] = await tx
          .update(bankRule)
          .set(ruleValues(req.body))
          .where(eq(bankRule.id, req.params.id))
          .returning();
        if (!r) throw notFound('Règle introuvable.');
        await audit(tx, req, {
          action: 'bank_rule.update',
          entity: 'bank_rule',
          entityId: r.id,
          after: r,
        });
        return r;
      }),
  );

  app.delete('/bank/rules/:id', { ...compta, schema: idParams }, async (req) =>
    db.transaction(async (tx) => {
      const [r] = await tx.delete(bankRule).where(eq(bankRule.id, req.params.id)).returning();
      if (!r) throw notFound('Règle introuvable.');
      await audit(tx, req, {
        action: 'bank_rule.delete',
        entity: 'bank_rule',
        entityId: r.id,
        before: r,
      });
      return { ok: true };
    }),
  );

  /** Tries a rule on the imported history before saving it. */
  app.post('/bank/rules/test', { ...compta, schema: { body: bankRuleSchema } }, async (req) => {
    ruleValues(req.body);
    const b = req.body;
    const rule = {
      priority: b.priority,
      pattern: b.pattern,
      matchType: b.matchType,
      direction: b.direction,
      minAmountCents: b.minAmount === null ? null : decimalToCents(b.minAmount),
      maxAmountCents: b.maxAmount === null ? null : decimalToCents(b.maxAmount),
      active: true,
    };
    const rows = await db.select().from(bankLine).orderBy(desc(bankLine.date)).limit(3000);
    const hits = rows.filter((l) =>
      matchRule([rule], { label: l.label, memo: l.memo, amountCents: decimalToCents(l.amount) }),
    );
    return {
      count: hits.length,
      scanned: rows.length,
      sample: hits
        .slice(0, 20)
        .map((l) => ({ id: l.id, date: l.date, label: l.label, amount: l.amount })),
    };
  });

  // --- Deposits (R-SES-04) -----------------------------------------------------------------------------

  app.get('/deposits', compta, async () =>
    db
      .select()
      .from(cashDeposit)
      .orderBy(desc(cashDeposit.date), desc(cashDeposit.createdAt))
      .limit(200),
  );

  app.post('/deposits', { ...compta, schema: { body: depositSchema } }, async (req) =>
    db.transaction(async (tx) => {
      const d = await createDeposit(tx, { ...req.body, userId: req.user!.id });
      await audit(tx, req, {
        action: 'deposit.create',
        entity: 'cash_deposit',
        entityId: d.id,
        after: req.body,
      });
      return d;
    }),
  );
};
