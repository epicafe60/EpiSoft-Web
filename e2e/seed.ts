import {
  household,
  member,
  membership,
  membershipType,
  posTab,
  product,
  productBarcode,
  walletEntry,
  type Db,
} from '@episoft/db';
import { eq } from 'drizzle-orm';

export const SEED = {
  chips: { name: 'Chips nature', ean: '3168930167983', price: '2.50' },
  bananas: { name: 'Bananes bio', price: '3.20' },
  buyer: { firstName: 'Marie', lastName: 'DUPONT', balance: '20.00' },
};

/** Lot 1 test data: a small catalogue with a till tab, and a household with a cagnotte. */
export async function seedLot1(db: Db): Promise<void> {
  const [tab] = await db.insert(posTab).values({ name: 'Fruits', sort: 1 }).returning();
  const [chips] = await db
    .insert(product)
    .values({ code: '111001', name: SEED.chips.name, salePrice: SEED.chips.price, stockQty: '10' })
    .returning();
  await db.insert(productBarcode).values({ ean: SEED.chips.ean, productId: chips!.id });
  await db.insert(product).values({
    code: '320037',
    name: SEED.bananas.name,
    salePrice: SEED.bananas.price,
    saleMode: 'WEIGHT',
    unit: 'KG',
    stockQty: '5',
    posTabId: tab!.id,
  });

  const [h] = await db.insert(household).values({}).returning();
  const [m] = await db
    .insert(member)
    .values({
      firstName: SEED.buyer.firstName,
      lastName: SEED.buyer.lastName,
      householdId: h!.id,
      status: 'ACTIVE',
      email: 'marie@example.org',
    })
    .returning();
  await db.update(household).set({ referentMemberId: m!.id }).where(eq(household.id, h!.id));
  await db.insert(walletEntry).values({ householdId: h!.id, amount: SEED.buyer.balance, kind: 'TOPUP', paymentMethod: 'CASH' });
  const [annual] = await db.select().from(membershipType).where(eq(membershipType.code, 'ANNUAL'));
  await db.insert(membership).values({
    householdId: h!.id,
    typeId: annual!.id,
    startDate: '2026-01-01',
    endDate: '2099-12-31',
    amount: '12.00',
  });
}
