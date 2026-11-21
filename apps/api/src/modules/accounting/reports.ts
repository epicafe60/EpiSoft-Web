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
  centsToDecimal,
  decimalToCents,
  formatEntryNumber,
  formatVatRate,
  vatBreakdownIncl,
  incomeStatement,
  reportQuerySchema,
  situation,
  type Section,
} from '@episoft/shared';
import type { Config } from '../../config';
import { toShopDate, tzSql } from '../../lib/dates';
import { loadPdfConfig, loadPdfLogo } from '../../lib/pdf-template';
import { reportPdf, reportXlsx, type ReportLine, type ReportTable } from '../../lib/report-output';
import { badRequest, notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';
import { budgetFor } from './budget';
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

    /** Budget vs réalisé (R-CPT-20). Needs a fiscal year. */
    async budget(q) {
      if (!q.fiscalYearId) throw badRequest('Choisissez un exercice.');
      const c = await budgetFor(db, q.fiscalYearId);
      const line = (r: (typeof c.expenses)[number]) =>
        cell({
          label: `${r.number} ${r.label}`,
          budget: money(r.budgetCents),
          actual: money(r.actualCents),
          variance: money(r.varianceCents),
          percent: r.percent === null ? null : `${r.percent} %`,
        });
      const total = (label: string, b: number, a: number) =>
        cell(
          { label, budget: money(b), actual: money(a), variance: money(a - b), percent: null },
          true,
        );
      return {
        title: 'Budget et réalisé',
        subtitle: await periodLabel(q),
        columns: [
          { key: 'label', label: 'Compte', type: 'text', width: 4 },
          { key: 'budget', label: 'Budget', type: 'money', width: 1.3 },
          { key: 'actual', label: 'Réalisé', type: 'money', width: 1.3 },
          { key: 'variance', label: 'Écart', type: 'money', width: 1.3 },
          { key: 'percent', label: 'Réalisé / budget', type: 'text', width: 1.2 },
        ],
        rows: [
          cell({ label: 'CHARGES' }, true),
          ...c.expenses.map(line),
          total('Total des charges', c.budgetExpensesCents, c.actualExpensesCents),
          cell({ label: 'PRODUITS' }, true),
          ...c.income.map(line),
          total('Total des produits', c.budgetIncomeCents, c.actualIncomeCents),
          total('Résultat', c.budgetResultCents, c.actualResultCents),
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

    /**
     * Cagnottes against account 411000, month by month and cumulated (integrity check CPT-03).
     * Not tied to a fiscal year: the cagnotte has no year, and neither does the running gap.
     */
    async 'wallet-411'(q) {
      const validatedOnly = q.status === 'VALIDATED';
      const res = await db.execute<{ m: string; wallet: string; acc: string }>(sql`
        with acc as (
          select to_char(e.date, 'YYYY-MM') as m, sum(l.credit - l.debit) as v
            from app.entry_line l
            join app.account a on a.id = l.account_id and a.number = '411000'
            join app.entry e on e.id = l.entry_id
           where (${!validatedOnly} or e.status = 'VALIDATED')
           group by 1),
        w as (
          select to_char(w.at at time zone ${tzSql()}, 'YYYY-MM') as m, sum(w.amount) as v
            from app.wallet_entry w group by 1)
        select coalesce(acc.m, w.m) as m, coalesce(w.v, 0)::text as wallet, coalesce(acc.v, 0)::text as acc
          from acc full join w on acc.m = w.m
         order by 1`);
      let cumWallet = 0;
      let cumAcc = 0;
      const rows = res.rows.map((r) => {
        const w = decimalToCents(r.wallet);
        const a = decimalToCents(r.acc);
        cumWallet += w;
        cumAcc += a;
        return cell({
          month: `${r.m.slice(5)}/${r.m.slice(0, 4)}`,
          wallet: money(w),
          acc: money(a),
          gap: money(a - w),
          cumWallet: money(cumWallet),
          cumAcc: money(cumAcc),
          cumGap: money(cumAcc - cumWallet),
        });
      });
      rows.push(
        cell(
          {
            month: 'Total',
            wallet: money(cumWallet),
            acc: money(cumAcc),
            gap: money(cumAcc - cumWallet),
            cumWallet: money(cumWallet),
            cumAcc: money(cumAcc),
            cumGap: money(cumAcc - cumWallet),
          },
          true,
        ),
      );
      return {
        title: 'Cagnottes et compte 411000',
        subtitle: validatedOnly
          ? 'Écritures validées uniquement · variations mensuelles et cumul'
          : 'Brouillons compris · variations mensuelles et cumul',
        columns: [
          { key: 'month', label: 'Mois', type: 'text', width: 1.2 },
          { key: 'wallet', label: 'Cagnottes (variation)', type: 'money', width: 1.4 },
          { key: 'acc', label: '411000 (variation)', type: 'money', width: 1.4 },
          { key: 'gap', label: 'Écart du mois', type: 'money', width: 1.3 },
          { key: 'cumWallet', label: 'Cagnottes cumulées', type: 'money', width: 1.4 },
          { key: 'cumAcc', label: '411000 cumulé', type: 'money', width: 1.4 },
          { key: 'cumGap', label: 'Écart cumulé', type: 'money', width: 1.3 },
        ],
        rows,
      };
    },

    /**
     * R-TVA-06: VAT collected on the sales and deductible on the supplier invoices, by rate, for a
     * period (the CA3 is filled from it). Sales: HT = round(sum TTC / (1 + rate)) per rate, never per
     * ticket; donations and top-ups of the cagnotte are out of the scope of VAT.
     */
    async vat(q) {
      // A month or a quarter (CA3): explicit dates win over the fiscal year.
      let from = q.from;
      let to = q.to;
      if (q.fiscalYearId && !q.from && !q.to) {
        const [fy] = await db.select().from(fiscalYear).where(eq(fiscalYear.id, q.fiscalYearId));
        if (!fy) throw notFound('Exercice introuvable.');
        from = fy.startDate;
        to = fy.endDate;
      }
      const salesRows = await db.execute<{ rate: string; cents: string }>(sql`
        select l.vat_rate::text as rate, coalesce(sum(l.line_total), 0)::text as cents
          from app.sale s
          join app.sale_line l on l.sale_id = s.id
          join app.product p on p.id = l.product_id
         where p.code <> '01004'
           and s.vat_regime = 'LIABLE'
           and (${from ?? null}::date is null or (s.sold_at at time zone ${tzSql()})::date >= ${from ?? null}::date)
           and (${to ?? null}::date is null or (s.sold_at at time zone ${tzSql()})::date <= ${to ?? null}::date)
         group by 1`);
      const purchaseRows = await db.execute<{ rate: string; excl: string; vat: string }>(sql`
        select l.rate::text as rate, sum(l.excl)::text as excl, sum(l.vat)::text as vat
          from app.supplier_invoice_vat_line l
          join app.supplier_invoice i on i.id = l.invoice_id
         where i.vat_regime = 'LIABLE'
           and (${from ?? null}::date is null or i.date >= ${from ?? null}::date)
           and (${to ?? null}::date is null or i.date <= ${to ?? null}::date)
         group by 1`);
      const sales = vatBreakdownIncl(
        salesRows.rows.map((r) => ({ rate: r.rate, inclCents: decimalToCents(r.cents) })),
      );
      const collected = new Map(
        sales.byRate.map((r) => [r.rate, { excl: r.exclCents, vat: r.vatCents }]),
      );
      const deductible = new Map(
        purchaseRows.rows.map((r) => [
          Number(r.rate).toFixed(2),
          { excl: decimalToCents(r.excl), vat: decimalToCents(r.vat) },
        ]),
      );
      const rates = [...new Set([...collected.keys(), ...deductible.keys()])].sort(
        (a, b) => Number(a) - Number(b),
      );
      const sum = { cHt: 0, cVat: 0, dHt: 0, dVat: 0 };
      const rows = rates.map((rate) => {
        const c = collected.get(rate) ?? { excl: 0, vat: 0 };
        const d = deductible.get(rate) ?? { excl: 0, vat: 0 };
        sum.cHt += c.excl;
        sum.cVat += c.vat;
        sum.dHt += d.excl;
        sum.dVat += d.vat;
        return cell({
          rate: formatVatRate(rate),
          salesBase: money(c.excl),
          collected: money(c.vat),
          purchasesBase: money(d.excl),
          deductible: money(d.vat),
          balance: money(c.vat - d.vat),
        });
      });
      rows.push(
        cell(
          {
            rate: 'Total',
            salesBase: money(sum.cHt),
            collected: money(sum.cVat),
            purchasesBase: money(sum.dHt),
            deductible: money(sum.dVat),
            balance: money(sum.cVat - sum.dVat),
          },
          true,
        ),
      );
      const result = sum.cVat - sum.dVat;
      rows.push(
        cell(
          {
            rate: result >= 0 ? 'TVA à payer' : 'Crédit de TVA',
            balance: money(Math.abs(result)),
          },
          true,
        ),
      );
      return {
        title: 'TVA collectée et déductible',
        // Only what was recorded under the LIABLE regime counts; franchise and exempt periods carry no VAT.
        subtitle: `${await periodLabel(q)} · opérations sous le régime assujetti uniquement · hors dons et cagnotte`,
        columns: [
          { key: 'rate', label: 'Taux', type: 'text', width: 1.4 },
          { key: 'salesBase', label: 'Ventes HT', type: 'money', width: 1.4 },
          { key: 'collected', label: 'TVA collectée', type: 'money', width: 1.4 },
          { key: 'purchasesBase', label: 'Achats HT', type: 'money', width: 1.4 },
          { key: 'deductible', label: 'TVA déductible', type: 'money', width: 1.4 },
          { key: 'balance', label: 'TVA due (collectée − déductible)', type: 'money', width: 1.8 },
        ],
        rows,
      };
    },

    /** Dettes fournisseurs par ancienneté (R-CPT-16). */
    async 'aged-payables'() {
      const today = toShopDate(new Date());
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
      const file = `${req.params.name}-${toShopDate(new Date())}`;
      if (req.query.format === 'xlsx') {
        return reply
          .header('content-disposition', `attachment; filename="${file}.xlsx"`)
          .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .send(await reportXlsx(table));
      }
      const identity = (await loadSettings(db))['association.identity'];
      const template = await loadPdfConfig(db, 'report');
      return reply
        .header('content-disposition', `attachment; filename="${file}.pdf"`)
        .type('application/pdf')
        .send(
          await reportPdf(
            table,
            identity,
            template.config,
            template.config.logo ? await loadPdfLogo(db) : null,
          ),
        );
    },
  );
};
