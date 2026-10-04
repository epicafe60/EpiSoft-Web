import { eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { account, budgetLine, fiscalYear, type Db } from '@episoft/db';
import {
  budgetComparison,
  budgetSchema,
  centsToDecimal,
  decimalToCents,
  type BudgetComparison,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/problem';
import { accountBalances } from './service';

/** R-CPT-20: the year's budget set against the books (class 6/7, closing result entry left out). */
export async function budgetFor(db: Db, fiscalYearId: string): Promise<BudgetComparison> {
  const [balances, lines] = await Promise.all([
    accountBalances(db, { fiscalYearId, excludeClosingResult: true }),
    db
      .select({ number: account.number, label: account.label, amount: budgetLine.amount })
      .from(budgetLine)
      .innerJoin(account, eq(account.id, budgetLine.accountId))
      .where(eq(budgetLine.fiscalYearId, fiscalYearId)),
  ]);
  return budgetComparison(
    balances,
    lines.map((l) => ({ number: l.number, label: l.label, budgetCents: decimalToCents(l.amount) })),
  );
}

export const budgetRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const compta = { preHandler: app.requireRoles('COMPTA') };
  const params = { params: z.object({ id: z.string().uuid() }) };

  app.get('/fiscal-years/:id/budget', { ...compta, schema: params }, async (req) => {
    const [fy] = await db.select().from(fiscalYear).where(eq(fiscalYear.id, req.params.id));
    if (!fy) throw notFound('Exercice introuvable.');
    const c = await budgetFor(db, fy.id);
    const fmt = (r: (typeof c.expenses)[number]) => ({
      number: r.number,
      label: r.label,
      budget: centsToDecimal(r.budgetCents),
      actual: centsToDecimal(r.actualCents),
      variance: centsToDecimal(r.varianceCents),
      percent: r.percent,
    });
    return {
      expenses: c.expenses.map(fmt),
      income: c.income.map(fmt),
      budgetResult: centsToDecimal(c.budgetResultCents),
      actualResult: centsToDecimal(c.actualResultCents),
    };
  });

  /** Replaces the whole budget of the year: lines at 0 are removed. */
  app.put(
    '/fiscal-years/:id/budget',
    { ...compta, schema: { ...params, body: budgetSchema } },
    async (req) =>
      db.transaction(async (tx) => {
        const [fy] = await tx.select().from(fiscalYear).where(eq(fiscalYear.id, req.params.id));
        if (!fy) throw notFound('Exercice introuvable.');
        const numbers = req.body.lines.map((l) => l.number);
        if (new Set(numbers).size !== numbers.length)
          throw badRequest('Un compte apparaît deux fois dans le budget.');
        const accounts = numbers.length
          ? await tx
              .select({ id: account.id, number: account.number })
              .from(account)
              .where(inArray(account.number, numbers))
          : [];
        const idOf = new Map(accounts.map((a) => [a.number, a.id]));
        const unknown = numbers.filter((n) => !idOf.has(n));
        if (unknown.length) throw badRequest(`Compte(s) inconnu(s) : ${unknown.join(', ')}.`);
        await tx.delete(budgetLine).where(eq(budgetLine.fiscalYearId, fy.id));
        const kept = req.body.lines.filter((l) => decimalToCents(l.amount) > 0);
        if (kept.length)
          await tx.insert(budgetLine).values(
            kept.map((l) => ({
              fiscalYearId: fy.id,
              accountId: idOf.get(l.number)!,
              amount: l.amount,
            })),
          );
        await audit(tx, req, {
          action: 'budget.save',
          entity: 'fiscal_year',
          entityId: fy.id,
          after: { lines: kept.length },
        });
        return { ok: true, lines: kept.length };
      }),
  );
};
