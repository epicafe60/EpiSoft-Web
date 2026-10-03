import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  account,
  entry,
  entryLine,
  fiscalYear,
  journal,
  supplier,
  supplierInvoice,
  type Db,
} from '@episoft/db';
import {
  AGE_BUCKETS,
  AGE_BUCKET_LABELS,
  agedPayables,
  balanceOf,
  balanceSheet,
  buildFec,
  centsToDecimal,
  decimalToCents,
  formatEntryNumber,
  incomeStatement,
  reportQuerySchema,
  situation,
  type FecLine,
  type Section,
} from '@episoft/shared';
import type { Config } from '../../config';
import { toParisDate } from '../../lib/dates';
import { reportPdf, reportXlsx, type ReportLine, type ReportTable } from '../../lib/report-output';
import { badRequest, notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';
import { accountBalances, entryFilters, type BalanceFilter } from './service';

const MAX_ROWS = 20_000;

const query = reportQuerySchema.extend({
  format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
});

const cell = (cells: Record<string, string | null>, bold = false): ReportLine => ({ cells, bold });
const money = (cents: number) => centsToDecimal(cents);
const frDate = (d: string) => d.split('-').reverse().join('/');

export const reportRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const compta = { preHandler: app.requireRoles('COMPTA') };

  async function periodLabel(q: z.infer<typeof query>) {
    if (q.fiscalYearId) {
      const [fy] = await db.select().from(fiscalYear).where(eq(fiscalYear.id, q.fiscalYearId));
      if (!fy) throw notFound('Exercice introuvable.');
      return `${fy.label} (${frDate(fy.startDate)} au ${frDate(fy.endDate)})`;
    }
    if (q.from || q.to)
      return `Du ${q.from ? frDate(q.from) : '…'} au ${q.to ? frDate(q.to) : '…'}`;
    return 'Toutes périodes';
  }

  const filterOf = (q: z.infer<typeof query>): BalanceFilter => ({
    fiscalYearId: q.fiscalYearId,
    from: q.from,
    to: q.to,
    journalId: q.journalId,
    accountFrom: q.accountFrom,
    accountTo: q.accountTo,
    status: q.status,
  });

  const sectionRows = (sections: Section[], sign: 1 | -1 = 1): ReportLine[] =>
    sections.flatMap((s) => [
      cell({ label: `${s.code} · ${s.label}`, amount: money(sign * s.cents) }, true),
      ...s.accounts.map((a) =>
        cell({ label: `    ${a.number} ${a.label}`, amount: money(sign * a.cents) }),
      ),
    ]);

  // --- Builders ------------------------------------------------------------------------------------

  const builders: Record<string, (q: z.infer<typeof query>) => Promise<ReportTable>> = {
    /** Journal: entry lines in date order. */
    async journal(q) {
      const rows = await db
        .select({
          date: entry.date,
          code: journal.code,
          number: entry.number,
          year: fiscalYear.startDate,
          piece: entry.pieceRef,
          account: account.number,
          label: entryLine.label,
          debit: entryLine.debit,
          credit: entryLine.credit,
          status: entry.status,
        })
        .from(entryLine)
        .innerJoin(entry, eq(entry.id, entryLine.entryId))
        .innerJoin(journal, eq(journal.id, entry.journalId))
        .innerJoin(fiscalYear, eq(fiscalYear.id, entry.fiscalYearId))
        .innerJoin(account, eq(account.id, entryLine.accountId))
        .where(and(...entryFilters(filterOf(q))))
        .orderBy(
          asc(entry.date),
          asc(journal.code),
          asc(entry.number),
          asc(entry.createdAt),
          asc(entryLine.lineNo),
        )
        .limit(MAX_ROWS);
      return {
        title: 'Journal des écritures',
        subtitle: await periodLabel(q),
        columns: [
          { key: 'date', label: 'Date', type: 'text', width: 1.1 },
          { key: 'number', label: 'N°', type: 'text', width: 1.6 },
          { key: 'piece', label: 'Pièce', type: 'text', width: 1.2 },
          { key: 'account', label: 'Compte', type: 'text', width: 1 },
          { key: 'label', label: 'Libellé', type: 'text', width: 4 },
          { key: 'debit', label: 'Débit', type: 'money', width: 1.3 },
          { key: 'credit', label: 'Crédit', type: 'money', width: 1.3 },
        ],
        rows: rows.map((r) =>
          cell({
            date: frDate(r.date),
            number:
              r.number === null
                ? 'brouillon'
                : formatEntryNumber(r.code, Number(r.year.slice(0, 4)), r.number),
            piece: r.piece,
            account: r.account,
            label: r.label,
            debit: decimalToCents(r.debit) ? r.debit : null,
            credit: decimalToCents(r.credit) ? r.credit : null,
          }),
        ),
      };
    },

    /** Grand livre: per account, lines with a running balance. */
    async ledger(q) {
      const rows = await db
        .select({
          accountNumber: account.number,
          accountLabel: account.label,
          date: entry.date,
          code: journal.code,
          label: entryLine.label,
          debit: entryLine.debit,
          credit: entryLine.credit,
        })
        .from(entryLine)
        .innerJoin(entry, eq(entry.id, entryLine.entryId))
        .innerJoin(journal, eq(journal.id, entry.journalId))
        .innerJoin(account, eq(account.id, entryLine.accountId))
        .where(and(...entryFilters(filterOf(q))))
        .orderBy(asc(account.number), asc(entry.date), asc(entry.createdAt), asc(entryLine.lineNo))
        .limit(MAX_ROWS);
      const out: ReportLine[] = [];
      let current = '';
      let running = 0;
      let debit = 0;
      let credit = 0;
      const flush = () => {
        if (!current) return;
        out.push(
          cell(
            {
              label: `Total ${current}`,
              debit: money(debit),
              credit: money(credit),
              balance: money(running),
            },
            true,
          ),
        );
      };
      for (const r of rows) {
        if (r.accountNumber !== current) {
          flush();
          current = r.accountNumber;
          running = debit = credit = 0;
          out.push(cell({ date: r.accountNumber, label: r.accountLabel }, true));
        }
        const d = decimalToCents(r.debit);
        const c = decimalToCents(r.credit);
        running += d - c;
        debit += d;
        credit += c;
        out.push(
          cell({
            date: frDate(r.date),
            journal: r.code,
            label: r.label,
            debit: d ? r.debit : null,
            credit: c ? r.credit : null,
            balance: money(running),
          }),
        );
      }
      flush();
      return {
        title: 'Grand livre',
        subtitle: await periodLabel(q),
        columns: [
          { key: 'date', label: 'Date / compte', type: 'text', width: 1.4 },
          { key: 'journal', label: 'Jnl', type: 'text', width: 0.8 },
          { key: 'label', label: 'Libellé', type: 'text', width: 4 },
          { key: 'debit', label: 'Débit', type: 'money', width: 1.3 },
          { key: 'credit', label: 'Crédit', type: 'money', width: 1.3 },
          { key: 'balance', label: 'Solde', type: 'money', width: 1.3 },
        ],
        rows: out,
      };
    },

    /** Balance générale (or auxiliary, with an account range such as 401000–401999). */
    async balance(q) {
      const balances = await accountBalances(db, filterOf(q));
      const rows = balances.map((b) => {
        const bal = balanceOf(b);
        return cell({
          account: b.number,
          label: b.label,
          debit: money(b.debitCents),
          credit: money(b.creditCents),
          balanceD: bal > 0 ? money(bal) : null,
          balanceC: bal < 0 ? money(-bal) : null,
        });
      });
      const sum = (f: (b: (typeof balances)[number]) => number) =>
        balances.reduce((s, b) => s + f(b), 0);
      rows.push(
        cell(
          {
            label: 'Totaux',
            debit: money(sum((b) => b.debitCents)),
            credit: money(sum((b) => b.creditCents)),
            balanceD: money(sum((b) => Math.max(balanceOf(b), 0))),
            balanceC: money(sum((b) => Math.max(-balanceOf(b), 0))),
          },
          true,
        ),
      );
      return {
        title: 'Balance des comptes',
        subtitle: await periodLabel(q),
        columns: [
          { key: 'account', label: 'Compte', type: 'text', width: 1 },
          { key: 'label', label: 'Libellé', type: 'text', width: 3.5 },
          { key: 'debit', label: 'Débit', type: 'money', width: 1.3 },
          { key: 'credit', label: 'Crédit', type: 'money', width: 1.3 },
          { key: 'balanceD', label: 'Solde débiteur', type: 'money', width: 1.3 },
          { key: 'balanceC', label: 'Solde créditeur', type: 'money', width: 1.3 },
        ],
        rows,
      };
    },

    /** Compte de résultat (R-CPT-16). */
    async income(q) {
      const accounts = (await loadSettings(db))['accounting.accounts'];
      const r = incomeStatement(
        await accountBalances(db, { ...filterOf(q), excludeClosingResult: true }),
        accounts,
      );
      return {
        title: 'Compte de résultat',
        subtitle: await periodLabel(q),
        columns: [
          { key: 'label', label: 'Poste', type: 'text', width: 5 },
          { key: 'amount', label: 'Montant', type: 'money', width: 1.5 },
        ],
        rows: [
          cell({ label: 'CHARGES' }, true),
          ...sectionRows(r.expenses),
          cell({ label: 'Total des charges', amount: money(r.totalExpensesCents) }, true),
          cell({ label: 'PRODUITS' }, true),
          ...sectionRows(r.income),
          cell({ label: 'Total des produits', amount: money(r.totalIncomeCents) }, true),
          cell(
            {
              label: r.resultCents >= 0 ? 'Résultat : excédent' : 'Résultat : déficit',
              amount: money(Math.abs(r.resultCents)),
            },
            true,
          ),
        ],
      };
    },

    /** Bilan simplifié (R-CPT-16). */
    async 'balance-sheet'(q) {
      const r = balanceSheet(await accountBalances(db, filterOf(q)));
      return {
        title: 'Bilan',
        subtitle: await periodLabel(q),
        columns: [
          { key: 'label', label: 'Poste', type: 'text', width: 5 },
          { key: 'amount', label: 'Montant', type: 'money', width: 1.5 },
        ],
        rows: [
          cell({ label: 'ACTIF' }, true),
          ...sectionRows(r.assets),
          cell({ label: 'Total de l’actif', amount: money(r.totalAssetsCents) }, true),
          cell({ label: 'PASSIF' }, true),
          ...sectionRows(r.liabilities),
          ...(r.pendingResultCents
            ? [cell({ label: 'Résultat de l’exercice', amount: money(r.pendingResultCents) }, true)]
            : []),
          cell({ label: 'Total du passif', amount: money(r.totalLiabilitiesCents) }, true),
        ],
      };
    },

    /** Situation intermédiaire (R-CPT-17). */
    async situation(q) {
      const accounts = (await loadSettings(db))['accounting.accounts'];
      const s = situation(
        await accountBalances(db, { ...filterOf(q), excludeClosingResult: true }),
        accounts,
      );
      const rows: [string, number, boolean?][] = [
        ['Ventes', s.salesCents],
        ['Achats', s.purchasesCents],
        ['Variation de stock', s.stockVariationCents],
        ['Marge brute', s.grossMarginCents, true],
        ['Autres produits (74 à 77)', s.otherIncomeCents],
        ['Charges (61 à 68)', s.expensesCents],
        ['Résultat', s.resultCents, true],
      ];
      return {
        title: 'Situation intermédiaire',
        subtitle: `${await periodLabel(q)}${s.marginRatePct !== null ? ` · taux de marge ${s.marginRatePct.toFixed(2).replace('.', ',')} %` : ''}`,
        columns: [
          { key: 'label', label: 'Poste', type: 'text', width: 5 },
          { key: 'amount', label: 'Montant', type: 'money', width: 1.5 },
        ],
        rows: rows.map(([label, cents, bold]) => cell({ label, amount: money(cents) }, bold)),
      };
    },

    /** Dettes fournisseurs par ancienneté (R-CPT-16). */
    async 'aged-payables'() {
      const today = toParisDate(new Date());
      const invoices = await db
        .select({
          supplierId: supplierInvoice.supplierId,
          supplierName: supplier.name,
          dueDate: supplierInvoice.dueDate,
          total: supplierInvoice.totalIncl,
        })
        .from(supplierInvoice)
        .innerJoin(supplier, eq(supplier.id, supplierInvoice.supplierId))
        .where(eq(supplierInvoice.status, 'TO_PAY'));
      const rows = agedPayables(
        invoices.map((i) => ({
          supplierId: i.supplierId,
          supplierName: i.supplierName,
          dueDate: i.dueDate,
          totalCents: decimalToCents(i.total),
        })),
        today,
      );
      const totals = Object.fromEntries(
        AGE_BUCKETS.map((b) => [b, rows.reduce((s, r) => s + r.buckets[b], 0)]),
      );
      return {
        title: 'Dettes fournisseurs par ancienneté',
        subtitle: `Au ${frDate(today)}`,
        columns: [
          { key: 'supplier', label: 'Fournisseur', type: 'text', width: 3 },
          ...AGE_BUCKETS.map((b) => ({
            key: b,
            label: AGE_BUCKET_LABELS[b],
            type: 'money' as const,
            width: 1.3,
          })),
          { key: 'total', label: 'Total', type: 'money', width: 1.3 },
        ],
        rows: [
          ...rows.map((r) =>
            cell({
              supplier: r.supplierName,
              ...Object.fromEntries(AGE_BUCKETS.map((b) => [b, money(r.buckets[b])])),
              total: money(r.totalCents),
            }),
          ),
          cell(
            {
              supplier: 'Total',
              ...Object.fromEntries(AGE_BUCKETS.map((b) => [b, money(totals[b]!)])),
              total: money(rows.reduce((s, r) => s + r.totalCents, 0)),
            },
            true,
          ),
        ],
      };
    },
  };

  app.get(
    '/reports/:name',
    {
      ...compta,
      schema: {
        params: z.object({ name: z.enum(Object.keys(builders) as [string, ...string[]]) }),
        querystring: query,
      },
    },
    async (req, reply) => {
      const build = builders[req.params.name];
      if (!build) throw notFound('Édition inconnue.');
      const table = await build(req.query);
      if (req.query.format === 'json') return table;
      const file = `${req.params.name}-${toParisDate(new Date())}`;
      if (req.query.format === 'xlsx') {
        return reply
          .header('content-disposition', `attachment; filename="${file}.xlsx"`)
          .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .send(await reportXlsx(table));
      }
      const identity = (await loadSettings(db))['association.identity'];
      return reply
        .header('content-disposition', `attachment; filename="${file}.pdf"`)
        .type('application/pdf')
        .send(await reportPdf(table, identity));
    },
  );

  /**
   * FEC (R-CPT-19): validated entries of a fiscal year, tab-separated. A year with drafts is
   * refused: the file must be complete.
   */
  app.get(
    '/reports/fec/:fiscalYearId',
    { ...compta, schema: { params: z.object({ fiscalYearId: z.string().uuid() }) } },
    async (req, reply) => {
      const [fy] = await db
        .select()
        .from(fiscalYear)
        .where(eq(fiscalYear.id, req.params.fiscalYearId));
      if (!fy) throw notFound('Exercice introuvable.');
      const [drafts] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(entry)
        .where(and(eq(entry.fiscalYearId, fy.id), eq(entry.status, 'DRAFT')));
      if (drafts!.n > 0)
        throw badRequest(
          `${drafts!.n} écriture(s) sont encore des brouillons : validez-les d’abord.`,
        );
      const rows = await db
        .select({
          code: journal.code,
          journalLabel: journal.label,
          number: entry.number,
          date: entry.date,
          account: account.number,
          accountLabel: account.label,
          pieceRef: entry.pieceRef,
          label: entryLine.label,
          debit: entryLine.debit,
          credit: entryLine.credit,
          lettering: entryLine.letteringCode,
          letteredOn: entryLine.letteredOn,
          validatedAt: entry.validatedAt,
        })
        .from(entryLine)
        .innerJoin(entry, eq(entry.id, entryLine.entryId))
        .innerJoin(journal, eq(journal.id, entry.journalId))
        .innerJoin(account, eq(account.id, entryLine.accountId))
        .where(eq(entry.fiscalYearId, fy.id))
        .orderBy(asc(journal.code), asc(entry.number), asc(entryLine.lineNo));
      const year = Number(fy.startDate.slice(0, 4));
      const lines: FecLine[] = rows.map((r) => ({
        journalCode: r.code,
        journalLabel: r.journalLabel,
        entryNumber: formatEntryNumber(r.code, year, r.number!),
        date: r.date,
        account: r.account,
        accountLabel: r.accountLabel,
        pieceRef: r.pieceRef,
        label: r.label,
        debitCents: decimalToCents(r.debit),
        creditCents: decimalToCents(r.credit),
        lettering: r.lettering,
        letteredOn: r.letteredOn,
        validatedOn: toParisDate(r.validatedAt ?? new Date()),
      }));
      const siren = (await loadSettings(db))['association.identity'].siren ?? 'SIREN';
      return reply
        .header(
          'content-disposition',
          `attachment; filename="${siren}FEC${fy.endDate.replaceAll('-', '')}.txt"`,
        )
        .type('text/plain; charset=utf-8')
        .send(buildFec(lines));
    },
  );
};
