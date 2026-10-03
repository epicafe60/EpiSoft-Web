import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import {
  centsToDecimal,
  formatDocNumber,
  orderTotals,
  parsePrice4,
  parseQtyToMilli,
} from '@episoft/shared';
import type { Tx } from '../index';
import * as s from '../schema';
import type { Report } from './lot1';
import type { LegacySource } from './source';
import { fixed } from './transform-lot1';
import {
  lineVatRate,
  orderStatus,
  transformInvoice,
  type LegacyInvoiceRow,
} from './transform-lot2';

// Legacy migration, lot 2 part (spec §9.1 step 7): purchase orders and their receipts,
// supplier invoices, inventory history. History only: no stock movement is created, the
// opening stock (lot 1 part) already includes everything received before the switch-over.

export async function migrateLot2(src: LegacySource, tx: Tx, r: Report): Promise<void> {
  const suppliers = new Map(
    (
      await tx
        .select({ id: s.supplier.id, code: s.supplier.legacyFnrcode })
        .from(s.supplier)
        .where(isNotNull(s.supplier.legacyFnrcode))
    ).map((x) => [x.code!, x.id]),
  );
  const products = new Map(
    (
      await tx
        .select({ id: s.product.id, code: s.product.code, vatRate: s.product.vatRate })
        .from(s.product)
    ).map((p) => [p.code, p]),
  );
  await migrateOrders(src, tx, r, suppliers, products);
  await migrateInvoices(src, tx, r, suppliers);
  await migrateInventories(src, tx, r, products);
}

type Products = Map<string, { id: string; code: string; vatRate: string }>;

async function migrateOrders(
  src: LegacySource,
  tx: Tx,
  r: Report,
  suppliers: Map<string, string>,
  products: Products,
) {
  const orders = await src.query<{
    FNRCOMID: number;
    FNRCOMDATE: string;
    FNRCOMFNR: string;
    FNRCOMSTATUS: number;
    FNRCOMMENT: string | null;
  }>(
    'SELECT FNRCOMID, FNRCOMDATE, FNRCOMFNR, FNRCOMSTATUS, FNRCOMMENT FROM epidatas.fnrcommands ORDER BY FNRCOMID',
  );
  const details = await src.query<{
    FDCOMID: number;
    FDCOMPROD: string;
    FDCOMQTY: number;
    FDCOMPRHT: number;
    FDCOMPRTVA: number | null;
  }>(
    'SELECT FDCOMID, FDCOMPROD, FDCOMQTY, FDCOMPRHT, FDCOMPRTVA FROM epidatas.fnrcomdetail ORDER BY FCOMDETID',
  );
  const linesOf = new Map<number, typeof details>();
  for (const d of details) linesOf.set(d.FDCOMID, [...(linesOf.get(d.FDCOMID) ?? []), d]);

  let migrated = 0;
  let receipts = 0;
  for (const o of orders) {
    const supplierId = suppliers.get(o.FNRCOMFNR.trim());
    if (!supplierId) {
      r.issues.push({
        entity: 'commande',
        legacyId: String(o.FNRCOMID),
        field: 'FNRCOMFNR',
        value: o.FNRCOMFNR,
        problem: 'fournisseur inexistant',
        action: 'non reprise',
      });
      continue;
    }
    const status = orderStatus(o.FNRCOMSTATUS);
    const year = Number(o.FNRCOMDATE.slice(0, 4));
    const values = {
      number: formatDocNumber('CF', year, o.FNRCOMID),
      supplierId,
      date: o.FNRCOMDATE,
      status,
      comment: o.FNRCOMMENT?.trim() || null,
      legacyFnrcomid: o.FNRCOMID,
    };
    const [po] = await tx
      .insert(s.purchaseOrder)
      .values(values)
      .onConflictDoUpdate({ target: s.purchaseOrder.legacyFnrcomid, set: values })
      .returning({ id: s.purchaseOrder.id });

    // Lines are rewritten at each run (history; receipt lines keep their own copy).
    await tx.delete(s.purchaseOrderLine).where(eq(s.purchaseOrderLine.orderId, po!.id));
    const lines = [];
    for (const d of linesOf.get(o.FNRCOMID) ?? []) {
      const p = products.get(d.FDCOMPROD?.trim() ?? '');
      const qty = fixed(d.FDCOMQTY, 3);
      if (!p || !qty || Number(qty) <= 0) {
        r.issues.push({
          entity: 'commande',
          legacyId: String(o.FNRCOMID),
          field: 'FDCOMPROD',
          value: `${d.FDCOMPROD} × ${d.FDCOMQTY}`,
          problem: !p ? 'produit inexistant' : 'quantité nulle ou négative',
          action: 'ligne non reprise',
        });
        continue;
      }
      lines.push({
        productId: p.id,
        qtyOrdered: qty,
        unitPriceExcl: fixed(d.FDCOMPRHT, 4) ?? '0',
        vatRate: lineVatRate(d.FDCOMPRTVA, p.vatRate),
      });
    }
    if (!lines.length) {
      r.issues.push({
        entity: 'commande',
        legacyId: String(o.FNRCOMID),
        field: 'fnrcomdetail',
        value: '0',
        problem: 'commande sans ligne',
        action: 'reprise vide',
      });
    } else {
      await tx
        .insert(s.purchaseOrderLine)
        .values(
          lines.map((l, i) => ({
            orderId: po!.id,
            lineNo: i + 1,
            ...l,
            qtyReceived: status === 'RECEIVED' ? l.qtyOrdered : '0',
          })),
        );
    }
    const t = orderTotals(
      lines.map((l) => ({
        qtyMilli: parseQtyToMilli(l.qtyOrdered)!,
        unitPriceExcl4: parsePrice4(l.unitPriceExcl)!,
        vatRate: l.vatRate,
      })),
    );
    await tx
      .update(s.purchaseOrder)
      .set({
        totalExcl: centsToDecimal(t.exclCents),
        totalVat: centsToDecimal(t.vatCents),
        totalIncl: centsToDecimal(t.inclCents),
      })
      .where(eq(s.purchaseOrder.id, po!.id));

    // §6.3: a receipt document for the orders EpiSoft finalised (status 3).
    if (o.FNRCOMSTATUS === 3 && lines.length) {
      const rv = {
        number: formatDocNumber('RC', year, o.FNRCOMID),
        orderId: po!.id,
        supplierId,
        date: o.FNRCOMDATE,
        comment: 'Réception EpiSoft (reprise, sans mouvement de stock)',
        legacyFnrcomid: o.FNRCOMID,
      };
      const [gr] = await tx
        .insert(s.goodsReceipt)
        .values(rv)
        .onConflictDoUpdate({ target: s.goodsReceipt.legacyFnrcomid, set: rv })
        .returning({ id: s.goodsReceipt.id });
      await tx.delete(s.goodsReceiptLine).where(eq(s.goodsReceiptLine.receiptId, gr!.id));
      await tx
        .insert(s.goodsReceiptLine)
        .values(
          lines.map((l, i) => ({
            receiptId: gr!.id,
            lineNo: i + 1,
            productId: l.productId,
            qty: l.qtyOrdered,
            unitPriceExcl: l.unitPriceExcl,
            vatRate: l.vatRate,
          })),
        );
      receipts++;
    }
    migrated++;
  }
  // New documents continue after the migrated numbers.
  await tx.execute(sql`
    insert into app.number_counter (key, value)
    select (case when number like 'CF-%' then 'po:' else 'receipt:' end) || substr(number, 4, 4), max(substr(number, 9)::int)
      from (select number from app.purchase_order union all select number from app.goods_receipt) x
     where number ~ '^(CF|RC)-[0-9]{4}-[0-9]+$'
     group by 1
    on conflict (key) do update set value = greatest(app.number_counter.value, excluded.value)`);
  r.counts.push({
    table: 'commande',
    source: orders.length,
    migrated,
    note: `${receipts} réception(s) historique(s), sans mouvement de stock`,
  });
}

async function migrateInvoices(
  src: LegacySource,
  tx: Tx,
  r: Report,
  suppliers: Map<string, string>,
) {
  const rows = await src.query<LegacyInvoiceRow>(
    'SELECT FACTID, FACTFNR, FACTPIECE, FACTDATE, FACTHT, FACTTVA, FACTTTC, FACTECH, FACTETAT, FACTMODE, FACTLINK, FACTCOM FROM epidatas.facturesfnr ORDER BY FACTID',
  );
  let migrated = 0;
  for (const row of rows) {
    const supplierId = suppliers.get(row.FACTFNR.trim());
    if (!supplierId) {
      r.issues.push({
        entity: 'facture',
        legacyId: String(row.FACTID),
        field: 'FACTFNR',
        value: row.FACTFNR,
        problem: 'fournisseur inexistant',
        action: 'non reprise',
      });
      continue;
    }
    const { draft: d, issues } = transformInvoice(row);
    r.issues.push(...issues);
    // The same piece twice for a supplier (unique in v2): the later one is suffixed.
    let pieceRef = d.pieceRef;
    const clash = await tx.query.supplierInvoice.findFirst({
      where: and(
        eq(s.supplierInvoice.supplierId, supplierId),
        eq(s.supplierInvoice.pieceRef, pieceRef),
        ne(s.supplierInvoice.legacyFactid, row.FACTID),
      ),
    });
    if (clash) {
      pieceRef = `${pieceRef} (${row.FACTID})`;
      r.issues.push({
        entity: 'facture',
        legacyId: String(row.FACTID),
        field: 'FACTPIECE',
        value: d.pieceRef,
        problem: 'pièce en double pour ce fournisseur (R-FAC-05)',
        action: `renommée « ${pieceRef} »`,
      });
    }
    const values = {
      supplierId,
      pieceRef,
      date: d.date,
      dueDate: d.dueDate,
      totalExcl: d.totalExcl,
      totalVat: d.totalVat,
      totalIncl: d.totalIncl,
      status: d.status,
      paymentMethod: d.paymentMethod,
      comment: d.comment,
      // Old invoices must not trigger the J−3 alert.
      dueReminderSentAt: new Date(),
      legacyFactid: row.FACTID,
    };
    await tx
      .insert(s.supplierInvoice)
      .values(values)
      .onConflictDoUpdate({ target: s.supplierInvoice.legacyFactid, set: values });
    migrated++;
  }
  r.counts.push({
    table: 'facture',
    source: rows.length,
    migrated,
    note: 'écritures comptables : lot 3',
  });
}

async function migrateInventories(src: LegacySource, tx: Tx, r: Report, products: Products) {
  const rows = await src.query<{ INVDATE: string | null; INVPROD: string; INVQTY: number | null }>(
    'SELECT INVDATE, INVPROD, INVQTY FROM epidatas.inventaire',
  );
  const byDate = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.INVDATE) continue;
    byDate.set(row.INVDATE, [...(byDate.get(row.INVDATE) ?? []), row]);
  }
  for (const [date, items] of byDate) {
    const values = {
      label: `Inventaire EpiSoft du ${date.split('-').reverse().join('/')}`,
      scope: {},
      status: 'VALIDATED' as const,
      openedAt: sql`(${date + ' 12:00:00'}::timestamp at time zone 'Europe/Paris')`,
      validatedAt: sql`(${date + ' 12:00:00'}::timestamp at time zone 'Europe/Paris')`,
      legacyDate: date,
    };
    const [inv] = await tx
      .insert(s.inventorySession)
      .values(values)
      .onConflictDoUpdate({ target: s.inventorySession.legacyDate, set: values })
      .returning({ id: s.inventorySession.id });
    await tx.delete(s.inventoryLine).where(eq(s.inventoryLine.sessionId, inv!.id));
    const seen = new Set<string>();
    const lines = [];
    for (const it of items) {
      const p = products.get(it.INVPROD.trim());
      const qty = fixed(it.INVQTY ?? 0, 3)!;
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      // History only: the theoretical stock of that day is unknown, no adjustment is replayed.
      lines.push({ sessionId: inv!.id, productId: p.id, theoreticalQty: qty, countedQty: qty });
    }
    if (lines.length) await tx.insert(s.inventoryLine).values(lines);
  }
  r.counts.push({
    table: 'inventaire',
    source: rows.length,
    migrated: byDate.size,
    note: 'sessions historiques, sans mouvement de stock',
  });
}
