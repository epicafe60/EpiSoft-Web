import {
  household,
  member,
  memberPayment,
  membership,
  membershipType,
  supplier,
  posTab,
  setting,
  product,
  productBarcode,
  stockMovement,
  walletEntry,
  type Db,
} from '@episoft/db';
import { eq } from 'drizzle-orm';

export const SEED = {
  chips: { name: 'Chips nature', ean: '3168930167983', price: '2.50' },
  bananas: { name: 'Bananes bio', price: '3.20' },
  buyer: { firstName: 'Marie', lastName: 'DUPONT', balance: '20.00' },
  honey: { code: '211001', name: 'Miel du Vexin', supplier: 'Ferme du Vexin' },
};

/** Lot 1 test data: a small catalogue with a till tab, and a household with a cagnotte. */
export async function seedLot1(db: Db): Promise<void> {
  // R-EVO-01 is off for the historic scenarios (anonymous sales); till-evo.spec.ts turns it on.
  await db.insert(setting).values({
    key: 'pos.options',
    value: {
      allowTransfer: false,
      discountsEnabled: false,
      membershipExpiredBlocking: false,
      requireMemberFirst: false,
    },
  });
  const [tab] = await db.insert(posTab).values({ name: 'Fruits', sort: 1 }).returning();
  const [chips] = await db
    .insert(product)
    .values({ code: '111001', name: SEED.chips.name, salePrice: SEED.chips.price, stockQty: '10' })
    .returning();
  await db.insert(productBarcode).values({ ean: SEED.chips.ean, productId: chips!.id });
  const [bananas] = await db
    .insert(product)
    .values({
      code: '320037',
      name: SEED.bananas.name,
      salePrice: SEED.bananas.price,
      saleMode: 'WEIGHT',
      unit: 'KG',
      stockQty: '5',
      posTabId: tab!.id,
    })
    .returning();
  // The cached stock always comes from movements: record the opening stock.
  await db.insert(stockMovement).values([
    { productId: chips!.id, qty: '10', kind: 'INITIAL' },
    { productId: bananas!.id, qty: '5', kind: 'INITIAL' },
  ]);

  // Lot 2 cycle: a supplier product under its minimum stock.
  const [farm] = await db
    .insert(supplier)
    .values({ code: '0701', name: SEED.honey.supplier, email: 'ferme@example.org' })
    .returning();
  await db.insert(product).values({
    code: SEED.honey.code,
    name: SEED.honey.name,
    supplierId: farm!.id,
    salePrice: '8.00',
    purchasePriceExcl: '5.0000',
    vatRate: '5.50',
    minStock: '6',
    saleCondition: 'BOTH',
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
  // A top-up is a member payment plus its cagnotte entry, like at the till.
  const [topup] = await db
    .insert(memberPayment)
    .values({
      householdId: h!.id,
      date: '2026-01-05',
      amount: SEED.buyer.balance,
      purpose: 'TOPUP',
      method: 'CASH',
    })
    .returning();
  await db.insert(walletEntry).values({
    householdId: h!.id,
    amount: SEED.buyer.balance,
    kind: 'TOPUP',
    paymentMethod: 'CASH',
    paymentId: topup!.id,
  });
  const [annual] = await db.select().from(membershipType).where(eq(membershipType.code, 'ANNUAL'));
  await db.insert(membership).values({
    householdId: h!.id,
    typeId: annual!.id,
    startDate: '2026-01-01',
    endDate: '2099-12-31',
    amount: '12.00',
  });
}
