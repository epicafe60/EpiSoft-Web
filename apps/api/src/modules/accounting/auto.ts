import { and, eq, sql } from 'drizzle-orm';
import {
  account,
  bankAccount,
  cashCount,
  cashDeposit,
  cashSession,
  entry,
  entryLine,
  memberPayment,
  numberCounter,
  sale,
  salePayment,
  supplier,
  supplierCreditAllocation,
  supplierCreditNote,
  supplierInvoice,
  supplierInvoiceVatLine,
  type DbOrTx,
  type Tx,
} from '@episoft/db';
import {
  buildDepositEntry,
  buildInvoiceEntry,
  buildInvoicePaymentEntry,
  buildSessionEntry,
  cashPaymentProblem,
  decimalToCents,
  isLiable,
  regularizationLines,
  splitRevenueVat,
  vatCollectedKey,
  type AccountMap,
  type VatRegime,
  type PlannedLine,
  type MoneyMethod,
  type PaymentMethod,
  type SupplierPaymentMethod,
} from '@episoft/shared';
import { toShopDate } from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/problem';
import { allocatedCents } from './credit-allocations';
import {
  accountMap,
  createEntry,
  ensureAccount,
  entryBySource,
  nextSupplierAccountNumber,
  plannedToLines,
  type EntryMode,
} from './service';

type SupplierMode = SupplierPaymentMethod;
const supplierModeToEntryMode = (m: SupplierMode | null): EntryMode =>
  m === 'DIRECT_DEBIT' ? 'DIRECT_DEBIT' : (m ?? null);

// --- R-CPT-08: cash session -------------------------------------------------------------------

/**
 * The VTE draft entry of a closed session. Revenue goes to the memberships (756), donations
 * (754) or sales (707, or the shelf's own account, Q6) account according to the product.
 * Sessions rebuilt from the legacy tickets are skipped: EpiCompta already holds their sales.
 */
export async function generateSessionEntry(
  tx: Tx,
  sessionId: string,
  userId: string | null,
): Promise<string | null> {
  const [s] = await tx.select().from(cashSession).where(eq(cashSession.id, sessionId));
  if (!s) throw notFound('Session inconnue.');
  if (s.legacyDate) return null;
  const existing = await entryBySource(tx, 'session', sessionId);
  if (existing) return existing.id;
  const lines = await sessionEntryPlan(tx, sessionId);
  if (!lines.length) return null;
  const date = toShopDate(s.closedAt ?? new Date());
  const id = await createEntry(tx, {
    journalCode: 'VTE',
    date,
    label: `Caisse du ${date.split('-').reverse().join('/')}`,
    pieceRef: null,
    mode: 'OTHER',
    lines: plannedToLines(lines),
    source: { type: 'session', id: sessionId },
    userId,
    autoFiscalYear: true,
  });
  await tx.update(cashSession).set({ entryId: id }).where(eq(cashSession.id, sessionId));
  return id;
}

/**
 * R-TVA-04: the revenue of a set of sessions by credit account (excl. VAT for the liable tickets)
 * and the VAT collected by rate. Shared by the entry of a session and the weekly proposals.
 * `withVat` false keeps everything TTC (an entry validated before the VAT split).
 */
export async function sessionsRevenue(
  tx: DbOrTx,
  sessionIds: string[],
  a: AccountMap,
  withVat = true,
): Promise<{
  revenue: Record<string, number>;
  vatCollected: { account: string; rate: string; cents: number }[];
}> {
  const list = sql.join(
    sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rev = await tx.execute<{
    kind: string;
    account: string | null;
    rate: string;
    regime: VatRegime;
    cents: string;
  }>(sql`
    select case when exists (select 1 from app.membership_type mt where mt.product_id = p.id) then 'MEMBERSHIP'
                when p.code = '01004' then 'DONATION' else 'SALES' end as kind,
           c.sales_account_number as account,
           l.vat_rate::text as rate,
           s.vat_regime::text as regime,
           coalesce(sum(l.line_total), 0)::text as cents
      from app.sale s
      join app.sale_line l on l.sale_id = s.id
      join app.product p on p.id = l.product_id
      left join app.category c on c.id = p.category_id
     where s.session_id in (${list})
     group by 1, 2, 3, 4`);
  const split = splitRevenueVat(
    rev.rows.map((r) => ({
      account:
        r.kind === 'MEMBERSHIP'
          ? a.memberships
          : r.kind === 'DONATION'
            ? a.donations
            : (r.account ?? a.sales),
      rate: r.rate,
      inclCents: decimalToCents(r.cents),
      // The regime of each ticket as it was recorded (a change never recomputes the past).
      regime: withVat ? r.regime : ('FRANCHISE' as VatRegime),
      // A donation is out of the scope of VAT; a membership follows the rate of its product.
      outOfScope: r.kind === 'DONATION',
    })),
    (rate) => {
      const key = vatCollectedKey(rate);
      return key ? a[key] : null;
    },
  );
  return split;
}

/**
 * What the VTE entry of a session is, from its tickets, top-ups and cash count as they are now.
 * R-TVA-04: the revenue of the liable tickets is booked excl. VAT with the VAT collected per rate;
 * franchise and exempt tickets are booked TTC. `withVat` false: the regularization of an entry
 * validated before the VAT split, which stays in its structure.
 */
async function sessionEntryPlan(tx: Tx, sessionId: string, withVat = true): Promise<PlannedLine[]> {
  const a = await accountMap(tx);
  const [count] = await tx.select().from(cashCount).where(eq(cashCount.sessionId, sessionId));

  const pays = await tx
    .select({
      method: salePayment.method,
      cents: sql<string>`coalesce(sum(${salePayment.amount}), 0)::text`,
    })
    .from(salePayment)
    .innerJoin(sale, eq(sale.id, salePayment.saleId))
    .where(eq(sale.sessionId, sessionId))
    .groupBy(salePayment.method);
  const payments: Partial<Record<PaymentMethod, number>> = {};
  for (const p of pays) payments[p.method as PaymentMethod] = decimalToCents(p.cents);

  const { revenue, vatCollected } = await sessionsRevenue(tx, [sessionId], a, withVat);

  const tops = await tx
    .select({
      method: memberPayment.method,
      cents: sql<string>`coalesce(sum(${memberPayment.amount}), 0)::text`,
    })
    .from(memberPayment)
    .where(and(eq(memberPayment.cashSessionId, sessionId), eq(memberPayment.purpose, 'TOPUP')))
    .groupBy(memberPayment.method);
  const topups: Partial<Record<MoneyMethod, number>> = {};
  for (const t of tops)
    if (t.method && t.method !== 'WALLET')
      topups[t.method as MoneyMethod] = decimalToCents(t.cents);

  return buildSessionEntry(
    {
      payments,
      revenue,
      vatCollected,
      topups,
      cashDifferenceCents: count ? decimalToCents(count.difference) : 0,
    },
    a,
  );
}

export type Regularization = 'created' | 'regenerated' | 'regularized' | 'unchanged' | 'legacy';

/**
 * Audit KV2, C02: brings the accounts of a closed session in line with its tickets after some
 * arrived late. A draft entry is regenerated; a validated entry is never touched (R-CPT-05): a
 * regularization entry carries the difference, so the session's lines add up to today's figures.
 */
export async function regularizeSessionEntry(
  tx: Tx,
  sessionId: string,
  userId: string,
): Promise<Regularization> {
  const [s] = await tx.select().from(cashSession).where(eq(cashSession.id, sessionId));
  if (!s) throw notFound('Session inconnue.');
  if (s.legacyDate) return 'legacy';
  const existing = await entryBySource(tx, 'session', sessionId);
  if (!existing)
    return (await generateSessionEntry(tx, sessionId, userId)) ? 'created' : 'unchanged';
  if (existing.status !== 'VALIDATED') {
    await tx.update(cashSession).set({ entryId: null }).where(eq(cashSession.id, sessionId));
    await tx.delete(entry).where(eq(entry.id, existing.id));
    await generateSessionEntry(tx, sessionId, userId);
    return 'regenerated';
  }
  // Every line already written for the session: its entry and the earlier regularizations.
  const recorded = await tx
    .select({
      account: account.number,
      debit: entryLine.debit,
      credit: entryLine.credit,
    })
    .from(entryLine)
    .innerJoin(entry, eq(entry.id, entryLine.entryId))
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(
      sql`(${entry.sourceType} = 'session' and ${entry.sourceId} = ${sessionId})
        or (${entry.sourceType} = 'session_regularization' and ${entry.sourceId} like ${sessionId + ':%'})`,
    );
  const date = toShopDate(new Date());
  const label = `Régularisation caisse du ${toShopDate(s.closedAt ?? new Date())
    .split('-')
    .reverse()
    .join('/')}`;
  const lines = regularizationLines(
    recorded.map((r) => ({
      account: r.account,
      debitCents: decimalToCents(r.debit),
      creditCents: decimalToCents(r.credit),
    })),
    // An entry validated before the VAT split stays in its structure (never rewritten).
    await sessionEntryPlan(
      tx,
      sessionId,
      recorded.length === 0 || recorded.some((r) => r.account.startsWith('4457')),
    ),
    label,
  );
  if (!lines.length) return 'unchanged';
  await createEntry(tx, {
    journalCode: 'VTE',
    date,
    label,
    pieceRef: null,
    mode: 'OTHER',
    lines: plannedToLines(lines),
    source: { type: 'session_regularization', id: `${sessionId}:${Date.now()}` },
    userId,
    autoFiscalYear: true,
  });
  return 'regularized';
}

// --- R-FAC-03: supplier invoices -------------------------------------------------------------------

export async function supplierAccountNumber(
  tx: Tx,
  supplierId: string,
): Promise<{ number: string; name: string }> {
  const [s] = await tx.select().from(supplier).where(eq(supplier.id, supplierId));
  if (!s) throw notFound('Fournisseur introuvable.');
  let number = s.accountNumber;
  if (!number || !/^\d{6}$/.test(number)) {
    number = await nextSupplierAccountNumber(tx);
    await tx.update(supplier).set({ accountNumber: number }).where(eq(supplier.id, s.id));
  }
  await ensureAccount(tx, number, s.name);
  return { number, name: s.name };
}

/**
 * Creates or refreshes the ACH draft of an invoice. A validated entry that already matches
 * is kept; one that no longer matches the invoice has to be reversed first (409).
 */
export async function syncInvoiceEntry(
  tx: Tx,
  invoiceId: string,
  userId: string | null,
): Promise<string> {
  const [inv] = await tx.select().from(supplierInvoice).where(eq(supplierInvoice.id, invoiceId));
  if (!inv) throw notFound('Facture introuvable.');
  const a = await accountMap(tx);
  const sup = await supplierAccountNumber(tx, inv.supplierId);
  const expense = inv.expenseAccountNumber ?? a.purchases;
  await ensureAccount(tx, expense, 'Achats');
  const label = `Facture ${sup.name}`;
  const regime = inv.vatRegime; // the regime of the invoice date, as recorded
  const vatRows = await tx
    .select()
    .from(supplierInvoiceVatLine)
    .where(eq(supplierInvoiceVatLine.invoiceId, invoiceId))
    .orderBy(supplierInvoiceVatLine.rate);
  // R-TVA-04: expense excl. VAT + deductible VAT per rate (44566) / supplier for the TTC. Outside
  // the LIABLE regime VAT is not recoverable: the VAT paid is a cost, the expense carries the TTC. The entry always balances
  // because the totals of the invoice are the sums of its lines.
  // A legacy invoice whose typed totals do not add up keeps the TTC-only entry.
  const split =
    isLiable(regime) &&
    vatRows.length > 0 &&
    decimalToCents(inv.totalExcl) + decimalToCents(inv.totalVat) === decimalToCents(inv.totalIncl);
  if (split) await ensureAccount(tx, a.vatDeductible, 'TVA déductible sur biens et services');
  const planned = buildInvoiceEntry({
    supplierAccount: sup.number,
    expenseLines: [
      { account: expense, cents: decimalToCents(split ? inv.totalExcl : inv.totalIncl) },
    ],
    vatLines: split
      ? vatRows
          .filter((v) => decimalToCents(v.vat) !== 0)
          .map((v) => ({ account: a.vatDeductible, rate: v.rate, cents: decimalToCents(v.vat) }))
      : [],
    label,
  });
  // Entries validated before the VAT split carry the TTC alone: they stay valid (never rewritten).
  const legacyPlanned = buildInvoiceEntry({
    supplierAccount: sup.number,
    expenseLines: [{ account: expense, cents: decimalToCents(inv.totalIncl) }],
    label,
  });
  const existing = await entryBySource(tx, 'invoice', invoiceId);

  if (existing?.status === 'VALIDATED') {
    const current = await tx
      .select({ number: account.number, debit: entryLine.debit, credit: entryLine.credit })
      .from(entryLine)
      .innerJoin(account, eq(account.id, entryLine.accountId))
      .where(eq(entryLine.entryId, existing.id));
    const matches = (plan: PlannedLine[]) =>
      current.length === plan.length &&
      plan.every((p) =>
        current.some(
          (c) =>
            c.number === p.account &&
            decimalToCents(c.debit) === p.debitCents &&
            decimalToCents(c.credit) === p.creditCents,
        ),
      );
    const same = (matches(planned) || matches(legacyPlanned)) && existing.date === inv.date;
    if (!same)
      throw conflict(
        'L’écriture comptable de cette facture est validée : contre-passez-la avant de modifier la facture.',
      );
    return existing.id;
  }
  if (existing) await tx.delete(entry).where(eq(entry.id, existing.id));
  const id = await createEntry(tx, {
    journalCode: 'ACH',
    date: inv.date,
    pieceRef: inv.pieceRef,
    label,
    mode: supplierModeToEntryMode(inv.paymentMethod as SupplierMode | null),
    lines: plannedToLines(planned),
    source: { type: 'invoice', id: invoiceId },
    userId,
    autoFiscalYear: true,
  });
  await tx.update(supplierInvoice).set({ entryId: id }).where(eq(supplierInvoice.id, invoiceId));
  return id;
}

/** Continuous lettering codes: AA, AB, … (R-FAC-04). */
export async function nextLetteringCode(tx: Tx): Promise<string> {
  const [row] = await tx
    .insert(numberCounter)
    .values({ key: 'lettering', value: 1 })
    .onConflictDoUpdate({
      target: numberCounter.key,
      set: { value: sql`${numberCounter.value} + 1` },
    })
    .returning({ value: numberCounter.value });
  const n = row!.value - 1;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return `${letters[Math.floor(n / 26) % 26]}${letters[n % 26]}${n >= 676 ? Math.floor(n / 676) : ''}`;
}

/**
 * R-FAC-04: the payment entry (401 debited, 512 or 531 credited), lettered with the invoice
 * entry, and the invoice marked as paid. `bankLineId` links a payment found in the bank.
 */
export async function payInvoice(
  tx: Tx,
  a: {
    invoiceId: string;
    date: string;
    method: SupplierMode;
    userId: string | null;
    bankAccountNumber?: string;
    label?: string;
  },
): Promise<{ entryId: string | null; invoiceEntryId: string }> {
  const [inv] = await tx
    .select()
    .from(supplierInvoice)
    .where(eq(supplierInvoice.id, a.invoiceId))
    .for('update');
  if (!inv) throw notFound('Facture introuvable.');
  if (inv.status === 'PAID') throw conflict('Cette facture est déjà réglée.');
  if (inv.status === 'CANCELLED')
    throw conflict('Cette facture est annulée : elle ne se règle pas.');
  const invoiceEntryId = await syncInvoiceEntry(tx, inv.id, a.userId);
  const accounts = await accountMap(tx);
  const sup = await supplierAccountNumber(tx, inv.supplierId);
  const cash = a.method === 'CASH';
  // Credit notes offset against the invoice reduce what is left to pay.
  const credited = await allocatedCents(tx, inv.id);
  const net = decimalToCents(inv.totalIncl) - credited;
  if (net < 0) throw conflict('Les avoirs imputés dépassent le montant de la facture.');
  // Legal cap of a payment in cash (art. D112-3 CMF), on the amount actually paid.
  if (cash) {
    const problem = cashPaymentProblem(net);
    if (problem) throw badRequest(problem);
  }
  const label = a.label ?? `Règlement facture ${inv.pieceRef} ${sup.name}`;
  let entryId: string | null = null;
  if (net > 0) {
    const planned = buildInvoicePaymentEntry({
      supplierAccount: sup.number,
      moneyAccount: cash ? accounts.cash : (a.bankAccountNumber ?? accounts.bank),
      cents: net,
      label,
    });
    // A payment that was reversed leaves its entry behind: each payment has its own source.
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(entry)
      .where(
        sql`${entry.sourceType} = 'invoice_payment' and ${entry.sourceId} like ${inv.id + '%'}`,
      );
    entryId = await createEntry(tx, {
      journalCode: cash ? 'CAI' : 'BNQ',
      date: a.date,
      pieceRef: inv.pieceRef,
      label,
      mode: supplierModeToEntryMode(a.method),
      lines: plannedToLines(planned),
      source: { type: 'invoice_payment', id: n === 0 ? inv.id : `${inv.id}:${n}` },
      userId: a.userId,
      autoFiscalYear: true,
    });
  }
  // Lettering of the supplier lines of the entries: the invoice, the payment and, when a credit
  // note was offset in full against this invoice alone, the credit note.
  const code = await nextLetteringCode(tx);
  const [supplierAccount] = await tx
    .select({ id: account.id })
    .from(account)
    .where(eq(account.number, sup.number));
  const group: string[] = [invoiceEntryId];
  if (entryId) group.push(entryId);
  const allocations = await tx
    .select({
      amount: supplierCreditAllocation.amount,
      total: supplierCreditNote.totalIncl,
      entryId: supplierCreditNote.entryId,
    })
    .from(supplierCreditAllocation)
    .innerJoin(supplierCreditNote, eq(supplierCreditNote.id, supplierCreditAllocation.creditNoteId))
    .where(eq(supplierCreditAllocation.invoiceId, inv.id));
  for (const al of allocations)
    if (al.entryId && decimalToCents(al.amount) === decimalToCents(al.total))
      group.push(al.entryId);
  await tx
    .update(entryLine)
    .set({ letteringCode: code, letteredOn: a.date })
    .where(
      and(
        eq(entryLine.accountId, supplierAccount!.id),
        sql`${entryLine.entryId} in (${sql.join(
          group.map((g) => sql`${g}::uuid`),
          sql`, `,
        )})`,
      ),
    );
  await tx
    .update(supplierInvoice)
    .set({
      status: 'PAID',
      paidAt: a.date,
      paymentMethod: net > 0 ? a.method : null,
      paymentEntryId: entryId,
    })
    .where(eq(supplierInvoice.id, inv.id));
  return { entryId, invoiceEntryId };
}

// --- R-SES-04 / R-CPT-11: deposits ------------------------------------------------------------------

export async function createDeposit(
  tx: Tx,
  d: {
    date: string;
    kind: 'CASH' | 'CHEQUES';
    amount: string;
    bankAccountId: string;
    cheques: unknown[];
    comment: string | null;
    userId: string;
  },
) {
  const [bank] = await tx
    .select({ b: bankAccount, number: account.number })
    .from(bankAccount)
    .innerJoin(account, eq(account.id, bankAccount.accountId))
    .where(eq(bankAccount.id, d.bankAccountId));
  if (!bank) throw notFound('Compte bancaire inconnu.');
  const a = await accountMap(tx);
  const cents = decimalToCents(d.amount);
  const chequeCents = (d.cheques as { amount: string }[]).reduce(
    (s, c) => s + decimalToCents(c.amount),
    0,
  );
  if (d.kind === 'CHEQUES' && d.cheques.length && chequeCents !== cents)
    throw conflict(
      `Le bordereau (${chequeCents / 100} €) ne correspond pas au montant remis (${cents / 100} €).`,
    );
  const label =
    d.kind === 'CASH'
      ? 'Remise d’espèces en banque'
      : `Remise de ${d.cheques.length || ''} chèque(s) en banque`.replace('  ', ' ');
  const planned = buildDepositEntry({
    bankAccount: bank.number,
    fromAccount: d.kind === 'CASH' ? a.cash : a.cheques,
    cents,
    label,
  });
  const [dep] = await tx
    .insert(cashDeposit)
    .values({
      date: d.date,
      kind: d.kind,
      amount: d.amount,
      bankAccountId: d.bankAccountId,
      chequeList: d.cheques,
      comment: d.comment,
      createdBy: d.userId,
    })
    .returning();
  const entryId = await createEntry(tx, {
    journalCode: 'BNQ',
    date: d.date,
    label,
    mode: d.kind === 'CASH' ? 'CASH' : 'CHEQUE',
    lines: plannedToLines(planned),
    source: { type: 'deposit', id: dep!.id },
    userId: d.userId,
    autoFiscalYear: true,
  });
  await tx.update(cashDeposit).set({ entryId }).where(eq(cashDeposit.id, dep!.id));
  return { id: dep!.id, entryId };
}
