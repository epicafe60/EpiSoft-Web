import { eq, sql } from 'drizzle-orm';
import { supplierCreditAllocation, type DbOrTx } from '@episoft/db';
import { decimalToCents } from '@episoft/shared';

/** Cents of credit notes offset against an invoice (the amount to pay is the total minus this). */
export async function allocatedCents(db: DbOrTx, invoiceId: string): Promise<number> {
  const [r] = await db
    .select({ total: sql<string>`coalesce(sum(${supplierCreditAllocation.amount}), 0)::text` })
    .from(supplierCreditAllocation)
    .where(eq(supplierCreditAllocation.invoiceId, invoiceId));
  return decimalToCents(r!.total);
}
