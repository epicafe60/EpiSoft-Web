import { and, eq, gt, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import {
  household,
  householdBalance,
  member,
  membership,
  membershipType,
  posTab,
  product,
  productBarcode,
  userRole,
  type Db,
} from '@episoft/db';
import type {
  MemberStatus,
  ProductKind,
  ProductStatus,
  SaleMode,
  Snapshot,
  Unit,
} from '@episoft/shared';
import { loadSettings } from '../admin/settings-store';

/**
 * R-OFF-02: data replicated on the till. Products and members are incremental (`since`);
 * households (balance, membership end) are always complete. No address, no password,
 * the badge token only hashed (R-SYNC-06).
 */
export async function buildSnapshot(db: Db, since: Date | null): Promise<Snapshot> {
  const serverTime = new Date();
  // Rows written during this query are caught by the next refresh.
  const cursor = new Date(serverTime.getTime() - 1000).toISOString();

  const prodRows = await db
    .select({
      id: product.id,
      code: product.code,
      name: product.name,
      kind: product.kind,
      saleMode: product.saleMode,
      unit: product.unit,
      unitQty: product.unitQty,
      status: product.status,
      salePrice: product.salePrice,
      vatRate: product.vatRate,
      posTabId: product.posTabId,
      posSort: product.posSort,
      posLabel: product.posLabel,
      imageId: product.imageId,
    })
    .from(product)
    .where(since ? gt(product.updatedAt, since) : ne(product.status, 'INACTIVE'));
  const ids = prodRows.map((p) => p.id);
  const barcodes = ids.length
    ? await db.select().from(productBarcode).where(inArray(productBarcode.productId, ids))
    : [];
  const types = await db.select().from(membershipType);

  const memberRows = await db
    .select({
      id: member.id,
      number: member.number,
      firstName: member.firstName,
      lastName: member.lastName,
      householdId: member.householdId,
      status: member.status,
      qrTokenHash: member.qrTokenHash,
      hasEmail: sql<boolean>`${member.email} is not null`,
    })
    .from(member)
    .where(since ? gt(member.updatedAt, since) : ne(member.status, 'ARCHIVED'));
  const cashiers = new Set(
    (
      await db
        .select({ id: userRole.memberId })
        .from(userRole)
        .where(eq(userRole.roleCode, 'CAISSE'))
    ).map((r) => r.id),
  );

  const ends = await db
    .select({ householdId: membership.householdId, end: max(membership.endDate) })
    .from(membership)
    .where(isNull(membership.cancelledAt))
    .groupBy(membership.householdId);
  const endBy = new Map(ends.map((e) => [e.householdId, e.end]));
  const households = await db
    .select({ id: household.id, number: household.number, balance: householdBalance.balance })
    .from(household)
    .innerJoin(householdBalance, eq(householdBalance.householdId, household.id));

  const settings = await loadSettings(db);
  const tabs = await db
    .select()
    .from(posTab)
    .where(since ? and(gt(posTab.updatedAt, since)) : undefined);

  return {
    cursor,
    full: !since,
    serverTime: serverTime.toISOString(),
    products: prodRows.map((p) => ({
      ...p,
      kind: p.kind as ProductKind,
      saleMode: p.saleMode as SaleMode,
      unit: p.unit as Unit | null,
      status: p.status as ProductStatus,
      eans: barcodes.filter((b) => b.productId === p.id).map((b) => b.ean),
      membershipTypeId: types.find((t) => t.productId === p.id)?.id ?? null,
    })),
    members: memberRows.map((m) => ({
      ...m,
      status: m.status as MemberStatus,
      isCashier: cashiers.has(m.id),
    })),
    households: households.map((h) => ({ ...h, membershipEnd: endBy.get(h.id) ?? null })),
    membershipTypes: types.map((t) => ({
      id: t.id,
      code: t.code,
      label: t.label,
      price: t.price,
      durationMonths: t.durationMonths,
      productId: t.productId,
      active: t.active,
    })),
    posTabs: tabs.map((t) => ({ id: t.id, name: t.name, sort: t.sort, active: t.active })),
    settings: {
      overdraftLimit: settings['wallet.overdraftLimit'].amount,
      sellToNonMembers: settings['pos.sellToNonMembers'].enabled,
      defaultFloat: settings['pos.defaultFloat'].amount,
      ...settings['pos.options'],
    },
  };
}
