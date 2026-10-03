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
  posDevice,
  sale,
  salePayment,
  supplier,
  supplierInvoice,
  type Tx,
} from '@episoft/db';
import {
  buildDepositEntry,
  buildInvoiceEntry,
  buildInvoicePaymentEntry,
  buildSessionEntry,
  decimalToCents,
  type MoneyMethod,
  type PaymentMethod,
  type SupplierPaymentMethod,
} from '@episoft/shared';
import { toParisDate } from '../../lib/dates';
import { conflict, notFound } from '../../lib/problem';
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
  const a = await accountMap(tx);
  const [device] = await tx.select().from(posDevice).where(eq(posDevice.id, s.deviceId));
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

  const rev = await tx.execute<{ kind: string; account: string | null; cents: string }>(sql`
    select case when exists (select 1 from app.membership_type mt where mt.product_id = p.id) then 'MEMBERSHIP'
                when p.code = '01004' then 'DONATION' else 'SALES' end as kind,
           c.sales_account_number as account,
           coalesce(sum(l.line_total), 0)::text as cents
      from app.sale s
      join app.sale_line l on l.sale_id = s.id
      join app.product p on p.id = l.product_id
      left join app.category c on c.id = p.category_id
     where s.session_id = ${sessionId}
     group by 1, 2`);
  const revenue: Record<string, number> = {};
  for (const r of rev.rows) {
    const acct =
      r.kind === 'MEMBERSHIP'
        ? a.memberships
        : r.kind === 'DONATION'
          ? a.donations
          : (r.account ?? a.sales);
    revenue[acct] = (revenue[acct] ?? 0) + decimalToCents(r.cents);
  }

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

  const lines = buildSessionEntry(
    {
      payments,
      revenue,
      topups,
      cashDifferenceCents: count ? decimalToCents(count.difference) : 0,
    },
    a,
  );
  if (!lines.length) return null;
  const date = toParisDate(s.closedAt ?? new Date());
  const id = await createEntry(tx, {
    journalCode: 'VTE',
    date,
    label: `Caisse ${device?.name ?? ''} du ${date.split('-').reverse().join('/')}`.trim(),
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

// --- R-FAC-03: supplier invoices -------------------------------------------------------------------

async function supplierAccountNumber(
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
  const planned = buildInvoiceEntry({
    supplierAccount: sup.number,
    expenseLines: [{ account: expense, cents: decimalToCents(inv.totalIncl) }],
    label: `Facture ${sup.name}`,
  });
  const existing = await entryBySource(tx, 'invoice', invoiceId);

  if (existing?.status === 'VALIDATED') {
    const current = await tx
      .select({ number: account.number, debit: entryLine.debit, credit: entryLine.credit })
      .from(entryLine)
      .innerJoin(account, eq(account.id, entryLine.accountId))
      .where(eq(entryLine.entryId, existing.id));
    const same =
      current.length === planned.length &&
      planned.every((p) =>
        current.some(
          (c) =>
            c.number === p.account &&
            decimalToCents(c.debit) === p.debitCents &&
            decimalToCents(c.credit) === p.creditCents,
        ),
      ) &&
      existing.date === inv.date;
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
    label: `Facture ${sup.name}`,
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
async function nextLetteringCode(tx: Tx): Promise<string> {
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
): Promise<{ entryId: string; invoiceEntryId: string }> {
  const [inv] = await tx
    .select()
    .from(supplierInvoice)
    .where(eq(supplierInvoice.id, a.invoiceId))
    .for('update');
  if (!inv) throw notFound('Facture introuvable.');
  if (inv.status === 'PAID') throw conflict('Cette facture est déjà réglée.');
  const invoiceEntryId = await syncInvoiceEntry(tx, inv.id, a.userId);
  const accounts = await accountMap(tx);
  const sup = await supplierAccountNumber(tx, inv.supplierId);
  const cash = a.method === 'CASH';
  const planned = buildInvoicePaymentEntry({
    supplierAccount: sup.number,
    moneyAccount: cash ? accounts.cash : (a.bankAccountNumber ?? accounts.bank),
    cents: decimalToCents(inv.totalIncl),
    label: a.label ?? `Règlement facture ${inv.pieceRef} ${sup.name}`,
  });
  const entryId = await createEntry(tx, {
    journalCode: cash ? 'CAI' : 'BNQ',
    date: a.date,
    pieceRef: inv.pieceRef,
    label: a.label ?? `Règlement facture ${inv.pieceRef} ${sup.name}`,
    mode: supplierModeToEntryMode(a.method),
    lines: plannedToLines(planned),
    source: { type: 'invoice_payment', id: inv.id },
    userId: a.userId,
    autoFiscalYear: true,
  });
  // Lettering of the supplier lines of both entries.
  const code = await nextLetteringCode(tx);
  const [supplierAccount] = await tx
    .select({ id: account.id })
    .from(account)
    .where(eq(account.number, sup.number));
  await tx
    .update(entryLine)
    .set({ letteringCode: code, letteredOn: a.date })
    .where(
      and(
        eq(entryLine.accountId, supplierAccount!.id),
        sql`${entryLine.entryId} in (${invoiceEntryId}, ${entryId})`,
      ),
    );
  await tx
    .update(supplierInvoice)
    .set({ status: 'PAID', paidAt: a.date, paymentMethod: a.method, paymentEntryId: entryId })
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
