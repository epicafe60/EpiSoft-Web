import { and, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { centsToDecimal, cleanText, formatSaleNumber, membershipEnd } from '@episoft/shared';
import type { Tx } from '../index';
import * as s from '../schema';
import type { LegacySource } from './source';
import type { Issue } from './transform';
import {
  fixed,
  legacyCents,
  parseTicketPayments,
  planPayment,
  transformProduct,
  type LegacyPaymentRow,
  type LegacyProductRow,
  firstContinuousTicketDate,
  isDebitCoveredByTickets,
} from './transform-lot1';

// Legacy migration, lot 1 part (spec §9.1 steps 3–6): suppliers, catalogue, images and
// till tabs, opening stock, memberships, payments and cagnotte, tickets with sessions
// rebuilt per day. Same rules as lot 0: SELECT only on MariaDB, idempotent, one transaction.

export interface Report {
  counts: { table: string; source: number; migrated: number; note: string }[];
  issues: Issue[];
  sheets: {
    name: string;
    columns: { header: string; key: string; width: number }[];
    rows: object[];
  }[];
}

/** Legacy datetimes and dates are Paris local time. */
const paris = (v: string) => sql`(${v}::timestamp at time zone 'Europe/Paris')`;
const parisNoon = (d: string) => sql`(${d + ' 12:00:00'}::timestamp at time zone 'Europe/Paris')`;
const today = () => new Date().toISOString().slice(0, 10);

export async function migrateLot1(src: LegacySource, tx: Tx, r: Report): Promise<void> {
  await migrateSuppliers(src, tx, r);
  await migrateCatalog(src, tx, r);
  await migrateImages(src, tx, r);
  await migrateMemberships(src, tx, r);
  await migratePayments(src, tx, r);
  await migrateTickets(src, tx, r);
  await reconcile(src, tx, r);
}

// --- Suppliers ------------------------------------------------------------------------

async function migrateSuppliers(src: LegacySource, tx: Tx, r: Report) {
  const rows = await src.query<{
    FNRCODE: string;
    FNRNOM: string | null;
    FNRCONTACT: string | null;
    FNRRUE: string | null;
    FNRCPOST: number | null;
    FNRCOMMUNE: number | null;
    FNRTELEPH: string | null;
    FNREMAIL: string | null;
    FNRSITEWEB: string | null;
    FNRACTIVE: number | null;
    FNRINFOPUB: string | null;
    FNRINFOPRIV: string | null;
    FNRRESP: number | null;
    FNRBONCMD: number | null;
    FNRCPTE: number | null;
    FNRTARIFS: string | null;
  }>(
    `SELECT FNRCODE, FNRNOM, FNRCONTACT, FNRRUE, FNRCPOST, FNRCOMMUNE, FNRTELEPH, FNREMAIL, FNRSITEWEB,
            FNRACTIVE, FNRINFOPUB, FNRINFOPRIV, FNRRESP, FNRBONCMD, FNRCPTE, FNRTARIFS
       FROM epicafe.fournisseurs ORDER BY FNRCODE`,
  );
  const communes = new Map(
    (
      await tx
        .select({ id: s.commune.id, legacy: s.commune.legacyCommuneId })
        .from(s.commune)
        .where(isNotNull(s.commune.legacyCommuneId))
    ).map((c) => [c.legacy!, c.id]),
  );
  const members = new Map(
    (
      await tx
        .select({ id: s.member.id, legacy: s.member.legacyMbreid })
        .from(s.member)
        .where(isNotNull(s.member.legacyMbreid))
    ).map((m) => [m.legacy!, m.id]),
  );
  for (const f of rows) {
    const code = f.FNRCODE.trim();
    if (f.FNRCOMMUNE && !communes.has(f.FNRCOMMUNE)) {
      r.issues.push({
        entity: 'fournisseur',
        legacyId: code,
        field: 'FNRCOMMUNE',
        value: String(f.FNRCOMMUNE),
        problem: 'commune inexistante',
        action: 'laissée vide',
      });
    }
    const values = {
      code,
      name: cleanText(f.FNRNOM) ?? code,
      contact: cleanText(f.FNRCONTACT),
      street: cleanText(f.FNRRUE),
      postcode: f.FNRCPOST ? String(f.FNRCPOST).padStart(5, '0') : null,
      communeId: f.FNRCOMMUNE ? (communes.get(f.FNRCOMMUNE) ?? null) : null,
      phone: cleanText(f.FNRTELEPH),
      email: cleanText(f.FNREMAIL),
      website: cleanText(f.FNRSITEWEB),
      priceListUrl: cleanText(f.FNRTARIFS),
      active: (f.FNRACTIVE ?? 0) !== 0,
      publicNotes: cleanText(f.FNRINFOPUB),
      privateNotes: cleanText(f.FNRINFOPRIV),
      referentMemberId: f.FNRRESP ? (members.get(f.FNRRESP) ?? null) : null,
      sendsPo: (f.FNRBONCMD ?? 0) !== 0,
      accountNumber: f.FNRCPTE ? String(f.FNRCPTE) : null,
      legacyFnrcode: code,
    };
    await tx
      .insert(s.supplier)
      .values(values)
      .onConflictDoUpdate({ target: s.supplier.legacyFnrcode, set: values });
  }
  r.counts.push({ table: 'fournisseur', source: rows.length, migrated: rows.length, note: '' });
}

// --- Catalogue, barcodes, opening stock ---------------------------------------------------

async function migrateCatalog(src: LegacySource, tx: Tx, r: Report) {
  const univ = await src.query<{ UNIVID: string; UNIVNOM: string }>(
    'SELECT UNIVID, UNIVNOM FROM epicafe.univers ORDER BY UNIVID',
  );
  for (const u of univ) {
    const values = {
      code: u.UNIVID.trim(),
      name: cleanText(u.UNIVNOM) ?? u.UNIVID,
      sort: Number(u.UNIVID) || 0,
    };
    await tx
      .insert(s.universe)
      .values(values)
      .onConflictDoUpdate({ target: s.universe.code, set: values });
  }
  const universes = new Map((await tx.select().from(s.universe)).map((u) => [u.code, u.id]));
  const rays = await src.query<{ RAYID: string; RAYUNIV: string; RAYNOM: string }>(
    'SELECT RAYID, RAYUNIV, RAYNOM FROM epicafe.rayons ORDER BY RAYID',
  );
  for (const ray of rays) {
    const universeId = universes.get(ray.RAYUNIV.trim());
    if (!universeId) {
      r.issues.push({
        entity: 'rayon',
        legacyId: ray.RAYID,
        field: 'RAYUNIV',
        value: ray.RAYUNIV,
        problem: 'univers inexistant',
        action: 'non repris',
      });
      continue;
    }
    const values = {
      universeId,
      code: ray.RAYID.trim(),
      name: cleanText(ray.RAYNOM) ?? ray.RAYID,
      sort: Number(ray.RAYID) || 0,
    };
    await tx
      .insert(s.category)
      .values(values)
      .onConflictDoUpdate({
        target: [s.category.universeId, s.category.code],
        set: { name: values.name, sort: values.sort },
      });
  }
  r.counts.push({ table: 'univers', source: univ.length, migrated: univ.length, note: '' });
  r.counts.push({ table: 'rayon', source: rays.length, migrated: rays.length, note: '' });

  const categories = new Map(
    (
      await tx
        .select({ id: s.category.id, code: s.category.code, universeId: s.category.universeId })
        .from(s.category)
    ).map((c) => [`${[...universes].find(([, id]) => id === c.universeId)?.[0]}:${c.code}`, c.id]),
  );
  const suppliers = new Map(
    (await tx.select({ id: s.supplier.id, code: s.supplier.legacyFnrcode }).from(s.supplier)).map(
      (x) => [x.code!, x.id],
    ),
  );

  const rows = await src.query<LegacyProductRow>(
    `SELECT p.PRODNUM, p.PRODNOM, p.PRODESCR, p.PRODTYPVTE, p.PRODQTE, p.PRODUNITVTE, p.PRODEAN13, p.PRODCONDVTE,
            p.PRODFNR, p.PRODREFFNR, p.PRODUNIV, p.PRODRAY, p.PRODQUALITE, p.PRODTVATX, p.PRODATCREA, p.PRODSTATUT,
            d.PRODPAHT, d.PRODPATTC, d.PRODPRIXVTE, d.PRODSTOCK, d.PRODSTKMIN, d.PRODPACHG
       FROM epicafe.produits p LEFT JOIN epicafe.prodatas d ON d.PRODATNUM = p.PRODNUM
      ORDER BY p.PRODNUM`,
  );
  const orphans = await src.query<{ PRODATNUM: string }>(
    'SELECT d.PRODATNUM FROM epicafe.prodatas d LEFT JOIN epicafe.produits p ON p.PRODNUM = d.PRODATNUM WHERE p.PRODNUM IS NULL',
  );
  for (const o of orphans) {
    r.issues.push({
      entity: 'produit',
      legacyId: o.PRODATNUM,
      field: 'PRODATNUM',
      value: o.PRODATNUM,
      problem: 'données (prix, stock) sans fiche produit',
      action: 'non repris',
    });
  }

  let withStock = 0;
  for (const row of rows) {
    const { draft: d, issues } = transformProduct(row);
    r.issues.push(...issues);
    const categoryId =
      d.universeCode && d.categoryCode
        ? (categories.get(`${d.universeCode}:${d.categoryCode}`) ?? null)
        : null;
    if (d.kind === 'GOODS' && !categoryId) {
      r.issues.push({
        entity: 'produit',
        legacyId: d.code,
        field: 'PRODRAY',
        value: `${d.universeCode}/${d.categoryCode}`,
        problem: 'rayon introuvable',
        action: 'rayon laissé vide',
      });
    }
    const supplierId = d.supplierCode ? (suppliers.get(d.supplierCode) ?? null) : null;
    if (d.supplierCode && !supplierId) {
      r.issues.push({
        entity: 'produit',
        legacyId: d.code,
        field: 'PRODFNR',
        value: d.supplierCode,
        problem: 'fournisseur inexistant',
        action: 'laissé vide',
      });
    }
    const values = {
      code: d.code,
      name: d.name,
      description: d.description,
      kind: d.kind,
      saleMode: d.saleMode,
      unitQty: d.unitQty,
      unit: d.unit,
      saleCondition: d.saleCondition,
      categoryId,
      supplierId,
      supplierRef: d.supplierRef,
      qualities: d.qualities,
      vatRate: d.vatRate,
      status: d.status,
      purchasePriceExcl: d.purchasePriceExcl,
      purchasePriceIncl: d.purchasePriceIncl,
      salePrice: d.salePrice,
      minStock: d.minStock,
      labelPending: d.labelPending,
      createdOn: d.createdOn,
    };
    const [p] = await tx
      .insert(s.product)
      .values(values)
      .onConflictDoUpdate({ target: s.product.code, set: values })
      .returning({ id: s.product.id });
    const productId = p!.id;

    if (d.ean) {
      const [owner] = await tx
        .select()
        .from(s.productBarcode)
        .where(eq(s.productBarcode.ean, d.ean));
      if (!owner) await tx.insert(s.productBarcode).values({ ean: d.ean, productId });
      else if (owner.productId !== productId) {
        r.issues.push({
          entity: 'produit',
          legacyId: d.code,
          field: 'PRODEAN13',
          value: d.ean,
          problem: 'code-barres déjà attribué à un autre produit',
          action: 'non repris',
        });
      }
    }
    const [hasHistory] = await tx
      .select({ id: s.priceHistory.id })
      .from(s.priceHistory)
      .where(eq(s.priceHistory.productId, productId))
      .limit(1);
    if (!hasHistory) {
      await tx.insert(s.priceHistory).values({
        productId,
        purchasePriceExcl: d.purchasePriceExcl,
        purchasePriceIncl: d.purchasePriceIncl,
        salePrice: d.salePrice,
        source: 'MIGRATION',
      });
    }

    // §9.1: one INITIAL movement per product, equal to PRODSTOCK at the migration date.
    await tx
      .delete(s.stockMovement)
      .where(
        and(
          eq(s.stockMovement.productId, productId),
          eq(s.stockMovement.kind, 'INITIAL'),
          eq(s.stockMovement.sourceType, 'legacy'),
        ),
      );
    if (d.kind === 'GOODS' && d.stock !== '0.000') {
      withStock++;
      await tx.insert(s.stockMovement).values({
        productId,
        qty: d.stock,
        kind: 'INITIAL',
        sourceType: 'legacy',
        sourceId: d.code,
        comment: 'Stock EpiSoft à la reprise',
      });
    }
    // The cached stock is the sum of the ledger (principle 6).
    await tx
      .update(s.product)
      .set({
        stockQty: sql`(select coalesce(sum(qty), 0) from app.stock_movement m where m.product_id = ${productId})`,
      })
      .where(eq(s.product.id, productId));
  }
  r.counts.push({
    table: 'produit',
    source: rows.length,
    migrated: rows.length,
    note: `${withStock} stocks initiaux`,
  });
}

// --- Images and till tabs (prodimg) ------------------------------------------------------

function mimeOf(b: Buffer): string | null {
  if (b.length > 4 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function migrateImages(src: LegacySource, tx: Tx, r: Report) {
  const tabs = await src.query<{ TABID: number; TABNAME: string }>(
    'SELECT TABID, TABNAME FROM prodimg.imgtabs ORDER BY TABID',
  );
  for (const t of tabs) {
    const values = {
      name: cleanText(t.TABNAME) ?? `Onglet ${t.TABID}`,
      sort: t.TABID,
      legacyTabid: t.TABID,
    };
    await tx
      .insert(s.posTab)
      .values(values)
      .onConflictDoUpdate({ target: s.posTab.legacyTabid, set: values });
  }
  const tabIds = new Map(
    (await tx.select().from(s.posTab).where(isNotNull(s.posTab.legacyTabid))).map((t) => [
      t.legacyTabid!,
      t.id,
    ]),
  );
  const images = await src.query<{
    IMGPRODID: string;
    IMGPRODIMG: Buffer | null;
    IMGLIBELLE: string | null;
    IMGTABID: number | null;
    IMGACTIVE: number | null;
  }>('SELECT IMGPRODID, IMGPRODIMG, IMGLIBELLE, IMGTABID, IMGACTIVE FROM prodimg.prodimages');
  let stored = 0;
  for (const img of images) {
    const code = img.IMGPRODID.trim();
    const [p] = await tx
      .select({ id: s.product.id, imageId: s.product.imageId })
      .from(s.product)
      .where(eq(s.product.code, code));
    if (!p) {
      r.issues.push({
        entity: 'image',
        legacyId: code,
        field: 'IMGPRODID',
        value: code,
        problem: 'produit inexistant',
        action: 'non reprise',
      });
      continue;
    }
    const active = (img.IMGACTIVE ?? 0) !== 0;
    const set: Partial<typeof s.product.$inferInsert> = {
      posTabId: active && img.IMGTABID !== null ? (tabIds.get(img.IMGTABID) ?? null) : null,
      posLabel: cleanText(img.IMGLIBELLE),
    };
    if (img.IMGPRODIMG && img.IMGPRODIMG.length) {
      const mime = mimeOf(img.IMGPRODIMG);
      if (!mime) {
        r.issues.push({
          entity: 'image',
          legacyId: code,
          field: 'IMGPRODIMG',
          value: `${img.IMGPRODIMG.length} octets`,
          problem: 'format d’image non reconnu',
          action: 'non reprise',
        });
      } else {
        const [m] = await tx
          .insert(s.media)
          .values({ mime, bytes: img.IMGPRODIMG })
          .returning({ id: s.media.id });
        set.imageId = m!.id;
        stored++;
      }
    }
    await tx.update(s.product).set(set).where(eq(s.product.id, p.id));
    if (set.imageId && p.imageId) await tx.delete(s.media).where(eq(s.media.id, p.imageId));
  }
  r.counts.push({ table: 'onglet', source: tabs.length, migrated: tabs.length, note: '' });
  r.counts.push({
    table: 'image',
    source: images.length,
    migrated: stored,
    note: 'fiches sans image : bouton de caisse seulement',
  });
}

// --- Memberships (adherents.ADHDATE) ------------------------------------------------------

async function migrateMemberships(src: LegacySource, tx: Tx, r: Report) {
  const rows = await src.query<{ ADHID: number; ADHDATE: string | null; ADHDUREE: number | null }>(
    'SELECT ADHID, ADHDATE, ADHDUREE FROM epicafe.adherents ORDER BY ADHID',
  );
  const [annual] = await tx
    .select()
    .from(s.membershipType)
    .where(eq(s.membershipType.code, 'ANNUAL'));
  const households = new Map(
    (
      await tx
        .select({ id: s.household.id, legacy: s.household.legacyAdhid })
        .from(s.household)
        .where(isNotNull(s.household.legacyAdhid))
    ).map((h) => [h.legacy!, h.id]),
  );
  let n = 0;
  for (const a of rows) {
    const householdId = households.get(a.ADHID);
    if (!householdId) continue;
    if (!a.ADHDATE || a.ADHDATE < '2000-01-01') {
      r.issues.push({
        entity: 'adhésion',
        legacyId: String(a.ADHID),
        field: 'ADHDATE',
        value: String(a.ADHDATE),
        problem: 'date d’adhésion vide',
        action: 'pas d’adhésion reprise',
      });
      continue;
    }
    const months = a.ADHDUREE ?? 12;
    const values = {
      householdId,
      typeId: annual!.id,
      startDate: a.ADHDATE,
      endDate: membershipEnd(a.ADHDATE, months),
      amount: annual!.price,
      legacyAdhid: a.ADHID,
    };
    await tx
      .insert(s.membership)
      .values(values)
      .onConflictDoUpdate({ target: s.membership.legacyAdhid, set: values });
    n++;
  }
  r.counts.push({
    table: 'adhésion',
    source: rows.length,
    migrated: n,
    note: 'dernière adhésion de chaque foyer (ADHDATE + ADHDUREE)',
  });
}

// --- Payments and cagnotte (adhpayements) --------------------------------------------------

async function migratePayments(src: LegacySource, tx: Tx, r: Report) {
  const rows = await src.query<LegacyPaymentRow>(
    'SELECT PAYID, PAYADHID, PAYDATE, PAYMNT, PAYMOTIF, PAYMOD FROM epidatas.adhpayements ORDER BY PAYID',
  );
  const days = await src.query<{ d: string }>(
    'SELECT DISTINCT DATE(TICKDATE) d FROM epidatas.tickets UNION SELECT DISTINCT DATE(TICKDATE) FROM epidatas.tmptickets',
  );
  const firstTicketDate = firstContinuousTicketDate(days.map((x) => x.d));
  let skippedDebits = 0;
  // Debits imported by an earlier run for the period now covered by the tickets.
  if (firstTicketDate)
    await tx.execute(
      sql`delete from app.wallet_entry where kind = 'PURCHASE' and legacy_payid is not null and at >= ${firstTicketDate.slice(0, 10)}::date`,
    );
  const households = new Map(
    (
      await tx
        .select({ id: s.household.id, legacy: s.household.legacyAdhid })
        .from(s.household)
        .where(isNotNull(s.household.legacyAdhid))
    ).map((h) => [h.legacy!, h.id]),
  );
  let payments = 0;
  let entries = 0;
  for (const row of rows) {
    const householdId = households.get(row.PAYADHID);
    if (!householdId) {
      r.issues.push({
        entity: 'paiement',
        legacyId: String(row.PAYID),
        field: 'PAYADHID',
        value: String(row.PAYADHID),
        problem: 'foyer non repris',
        action: 'non repris',
      });
      continue;
    }
    const { plan, issues } = planPayment(row, today());
    r.issues.push(...issues);
    if (!plan) continue;
    if (isDebitCoveredByTickets(plan, row.PAYDATE, firstTicketDate)) {
      skippedDebits++;
      continue;
    }
    const date = row.PAYDATE;
    let paymentId: string | null = null;
    if (plan.kind === 'payment' || plan.kind === 'topup') {
      const values = {
        householdId,
        date,
        amount: plan.amount,
        purpose: plan.kind === 'topup' ? ('TOPUP' as const) : plan.purpose,
        method: plan.method,
        comment: 'Reprise EpiSoft',
        legacyPayid: row.PAYID,
      };
      const [p] = await tx
        .insert(s.memberPayment)
        .values(values)
        .onConflictDoUpdate({ target: s.memberPayment.legacyPayid, set: values })
        .returning({ id: s.memberPayment.id });
      paymentId = p!.id;
      payments++;
    }
    if (plan.kind === 'topup' || plan.kind === 'wallet') {
      const values = {
        householdId,
        at: parisNoon(date),
        amount: plan.amount,
        kind: plan.kind === 'topup' ? ('TOPUP' as const) : plan.walletKind,
        paymentMethod: plan.kind === 'topup' ? plan.method : null,
        paymentId,
        comment: plan.kind === 'wallet' ? plan.comment : 'Versement (reprise EpiSoft)',
        legacyPayid: row.PAYID,
      };
      await tx
        .insert(s.walletEntry)
        .values(values)
        .onConflictDoUpdate({ target: s.walletEntry.legacyPayid, set: values });
      entries++;
    }
  }
  r.counts.push({
    table: 'paiement',
    source: rows.length,
    migrated: payments,
    note: `${entries} opérations de cagnotte ; ${skippedDebits} débits 01011 non repris (remplacés par les tickets dès le ${firstTicketDate?.slice(0, 10) ?? '—'})`,
  });
}

// --- Tickets and sessions --------------------------------------------------------------------

interface LegacyTicket {
  TICKNUM: number;
  TICKENCID: number;
  TICKADH: number;
  TICKDATE: string;
  TICKMNT: number;
  TICKMODPAY: string;
  TICKHASEXTRA: number | null;
}
interface LegacyLine {
  TICKDETNUM: number;
  TICKPRODID: string;
  TICKPRODPU: number;
  TICKDETQTE: number;
}

async function migrateTickets(src: LegacySource, tx: Tx, r: Report) {
  const tickets = await src.query<LegacyTicket>(
    'SELECT TICKNUM, TICKENCID, TICKADH, TICKDATE, TICKMNT, TICKMODPAY, TICKHASEXTRA FROM epidatas.tickets ORDER BY TICKNUM',
  );
  const lines = await src.query<LegacyLine>(
    'SELECT TICKDETNUM, TICKPRODID, TICKPRODPU, TICKDETQTE FROM epidatas.ticketdetails',
  );
  const tmpTickets = await src.query<LegacyTicket>(
    'SELECT TICKNUM, TICKENCID, TICKADH, TICKDATE, TICKMNT, TICKMODPAY, TICKHASEXTRA FROM epidatas.tmptickets ORDER BY TICKDATE, TICKNUM',
  );
  const tmpLines = await src.query<LegacyLine>(
    'SELECT TICKDETNUM, TICKPRODID, TICKPRODPU, TICKDETQTE FROM epidatas.tmpticketdetails',
  );

  // Device and sessions: one closed session per day (§9.1 step 5).
  const [device] = await tx
    .insert(s.posDevice)
    .values({ name: 'EPISOFT', active: false })
    .onConflictDoUpdate({ target: s.posDevice.name, set: { active: false } })
    .returning({ id: s.posDevice.id });

  const members = new Map(
    (
      await tx
        .select({
          id: s.member.id,
          legacy: s.member.legacyMbreid,
          householdId: s.member.householdId,
        })
        .from(s.member)
        .where(isNotNull(s.member.legacyMbreid))
    ).map((m) => [m.legacy!, m]),
  );
  const products = new Map(
    (
      await tx
        .select({
          id: s.product.id,
          code: s.product.code,
          kind: s.product.kind,
          vatRate: s.product.vatRate,
        })
        .from(s.product)
    ).map((p) => [p.code, p]),
  );

  // Tickets still in the tmp tables (not closed in EpiSoft) are re-imported at each run.
  await tx.execute(
    sql`delete from app.wallet_entry where sale_id in (select id from app.sale where legacy_ref like 'TMP:%')`,
  );
  await tx.delete(s.sale).where(like(s.sale.legacyRef, 'TMP:%'));
  const existing = new Set(
    (
      await tx.select({ ref: s.sale.legacyRef }).from(s.sale).where(isNotNull(s.sale.legacyRef))
    ).map((x) => x.ref!),
  );

  const linesBy = (rows: LegacyLine[]) => {
    const m = new Map<number, LegacyLine[]>();
    for (const l of rows) m.set(l.TICKDETNUM, [...(m.get(l.TICKDETNUM) ?? []), l]);
    return m;
  };
  const closedLines = linesBy(lines);
  const openLines = linesBy(tmpLines);
  const orphanLines = lines.filter((l) => !tickets.some((t) => t.TICKNUM === l.TICKDETNUM));
  if (orphanLines.length) {
    r.issues.push({
      entity: 'ticket',
      legacyId: '*',
      field: 'TICKDETNUM',
      value: String(orphanLines.length),
      problem: `${orphanLines.length} ligne(s) sans ticket`,
      action: 'non reprises',
    });
  }

  const maxNum = tickets.reduce((m, t) => Math.max(m, t.TICKNUM), 0);
  const all = [
    ...tickets.map((t) => ({
      t,
      ref: `T:${t.TICKNUM}`,
      num: t.TICKNUM,
      lines: closedLines.get(t.TICKNUM) ?? [],
    })),
    // Not closed in EpiSoft: numbered after the last closed ticket, as the closing would do.
    ...tmpTickets.map((t, i) => ({
      t,
      ref: `TMP:${t.TICKNUM}`,
      num: maxNum + i + 1,
      lines: openLines.get(t.TICKNUM) ?? [],
    })),
  ];
  if (tmpTickets.length) {
    r.issues.push({
      entity: 'ticket',
      legacyId: '*',
      field: 'tmptickets',
      value: String(tmpTickets.length),
      problem: 'tickets non clôturés dans EpiSoft (clôture cassée, anomalie C1)',
      action: 'repris avec un numéro après le dernier ticket ; ré-importés à chaque reprise',
    });
  }

  // Sessions: first and last ticket of each day.
  const days = new Map<string, { first: string; last: string }>();
  for (const { t } of all) {
    const day = t.TICKDATE.slice(0, 10);
    const d = days.get(day);
    if (!d) days.set(day, { first: t.TICKDATE, last: t.TICKDATE });
    else {
      if (t.TICKDATE < d.first) d.first = t.TICKDATE;
      if (t.TICKDATE > d.last) d.last = t.TICKDATE;
    }
  }
  const sessionOf = new Map<string, string>();
  for (const [day, d] of days) {
    const [row] = await tx
      .insert(s.cashSession)
      .values({
        id: uuidv7(),
        deviceId: device!.id,
        openedAt: paris(d.first),
        closedAt: paris(d.last),
        openingFloat: '0',
        status: 'CLOSED',
        legacyDate: day,
      })
      .onConflictDoUpdate({
        target: s.cashSession.legacyDate,
        set: { openedAt: paris(d.first), closedAt: paris(d.last) },
      })
      .returning({ id: s.cashSession.id });
    sessionOf.set(day, row!.id);
  }

  let migrated = 0;
  let mismatch = 0;
  for (const { t, ref, num, lines: tl } of all) {
    if (existing.has(ref)) continue;
    const cashier = members.get(t.TICKENCID);
    const buyer = t.TICKADH ? members.get(t.TICKADH) : undefined;
    if (t.TICKADH && !buyer) {
      r.issues.push({
        entity: 'ticket',
        legacyId: ref,
        field: 'TICKADH',
        value: String(t.TICKADH),
        problem: 'adhérent non repris',
        action: 'vente sans adhérent',
      });
    }
    const totalCents = legacyCents(t.TICKMNT);
    const year = Number(t.TICKDATE.slice(0, 4));
    const saleId = uuidv7();
    const saleLines = [];
    let linesCents = 0;
    for (const [i, l] of tl.entries()) {
      let p = products.get(l.TICKPRODID.trim());
      if (!p) {
        // Product deleted from EpiSoft: an inactive placeholder keeps the history readable.
        const code = l.TICKPRODID.trim();
        const [created] = await tx
          .insert(s.product)
          .values({ code, name: `Produit inconnu ${code} (reprise)`, status: 'INACTIVE' })
          .onConflictDoUpdate({ target: s.product.code, set: { status: 'INACTIVE' } })
          .returning({
            id: s.product.id,
            code: s.product.code,
            kind: s.product.kind,
            vatRate: s.product.vatRate,
          });
        p = created!;
        products.set(code, p);
        r.issues.push({
          entity: 'ticket',
          legacyId: ref,
          field: 'TICKPRODID',
          value: code,
          problem: 'produit inexistant',
          action: 'produit inactif créé',
        });
      }
      const lineCents = legacyCents(l.TICKPRODPU * l.TICKDETQTE);
      linesCents += lineCents;
      saleLines.push({
        saleId,
        lineNo: i + 1,
        productId: p.id,
        label: p.code,
        qty: fixed(l.TICKDETQTE, 3)!,
        unitPrice: fixed(l.TICKPRODPU, 4)!,
        catalogPrice: null,
        discount: '0',
        lineTotal: centsToDecimal(lineCents),
        vatRate: p.vatRate,
      });
    }
    if (tl.length && linesCents !== totalCents) mismatch++;
    let pays = parseTicketPayments(t.TICKMODPAY);
    if (!pays) {
      r.issues.push({
        entity: 'ticket',
        legacyId: ref,
        field: 'TICKMODPAY',
        value: t.TICKMODPAY,
        problem: 'règlement illisible',
        action: 'espèces pour le total',
      });
      pays = [{ method: 'CASH', cents: totalCents }];
    } else if (pays.reduce((a, p) => a + p.cents, 0) !== totalCents) {
      r.issues.push({
        entity: 'ticket',
        legacyId: ref,
        field: 'TICKMODPAY',
        value: t.TICKMODPAY,
        problem: `règlements différents du total (${centsToDecimal(totalCents)})`,
        action: 'repris tels quels',
      });
    }
    await tx.insert(s.sale).values({
      id: saleId,
      number: formatSaleNumber(year, num),
      sessionId: sessionOf.get(t.TICKDATE.slice(0, 10))!,
      deviceId: device!.id,
      cashierId: cashier?.id ?? null,
      memberId: buyer?.id ?? null,
      householdId: buyer?.householdId ?? null,
      soldAt: paris(t.TICKDATE),
      total: centsToDecimal(totalCents),
      hasServices: (t.TICKHASEXTRA ?? 0) !== 0 || tl.some((l) => l.TICKPRODID.trim().length === 5),
      legacyRef: ref,
    });
    // Labels are the product names at migration time.
    if (saleLines.length) {
      await tx.insert(s.saleLine).values(saleLines);
      await tx.execute(
        sql`update app.sale_line l set label = p.name from app.product p where l.sale_id = ${saleId} and p.id = l.product_id`,
      );
    }
    if (pays.length)
      await tx
        .insert(s.salePayment)
        .values(pays.map((p) => ({ saleId, method: p.method, amount: centsToDecimal(p.cents) })));
    migrated++;
  }
  if (mismatch) {
    r.issues.push({
      entity: 'ticket',
      legacyId: '*',
      field: 'TICKMNT',
      value: String(mismatch),
      problem: `${mismatch} ticket(s) dont le total diffère de la somme des lignes (arrondis EpiSoft)`,
      action: 'total d’origine conservé (§9.2)',
    });
  }

  await debitWalletFromTickets(tx, r);

  // New tickets continue after the migrated numbers of each year.
  await tx.execute(sql`
    insert into app.number_counter (key, value)
    select 'sale:' || substr(number, 3, 4), max(substr(number, 8)::int) from app.sale where number ~ '^T-[0-9]{4}-[0-9]{6}$' group by 1
    on conflict (key) do update set value = greatest(app.number_counter.value, excluded.value)`);

  r.counts.push({
    table: 'ticket',
    source: tickets.length + tmpTickets.length,
    migrated,
    note: `${days.size} sessions reconstituées ; déjà repris : ${existing.size - [...existing].filter((x) => x.startsWith('TMP:')).length}`,
  });

  // §9.2: monthly sales totals, source and target.
  const source = await src.query<{ m: string; total: string }>(
    `SELECT DATE_FORMAT(TICKDATE, '%Y-%m') m, SUM(TICKMNT) total FROM epidatas.tickets GROUP BY 1 ORDER BY 1`,
  );
  const target = await tx.execute<{ m: string; total: string }>(
    sql`select to_char(sold_at at time zone 'Europe/Paris', 'YYYY-MM') as m, sum(total)::text as total from app.sale where legacy_ref like 'T:%' group by 1 order by 1`,
  );
  const targetBy = new Map(target.rows.map((x) => [x.m, x.total]));
  r.sheets.push({
    name: 'Ventes par mois',
    columns: [
      { header: 'Mois', key: 'm', width: 10 },
      { header: 'EpiSoft', key: 'source', width: 14 },
      { header: 'EpiSoft-Web', key: 'target', width: 14 },
      { header: 'Écart', key: 'diff', width: 10 },
    ],
    rows: source.map((x) => {
      const sc = legacyCents(x.total);
      const tc = legacyCents(targetBy.get(x.m) ?? 0);
      return {
        m: x.m,
        source: centsToDecimal(sc),
        target: centsToDecimal(tc),
        diff: centsToDecimal(tc - sc),
      };
    }),
  });
}

// --- Cagnotte reconciliation (anomaly C2, §9.1 step 3) ----------------------------------------

async function reconcile(src: LegacySource, tx: Tx, r: Report) {
  const legacy = await src.query<{
    ADHID: number;
    ADHSOLDE: string;
    debits: string | null;
    cag: string | null;
  }>(
    `SELECT a.ADHID, a.ADHSOLDE,
            (SELECT SUM(PAYMNT) FROM epidatas.adhpayements p WHERE p.PAYADHID = a.ADHID AND p.PAYMOTIF = '01011') debits,
            (SELECT SUM(CAST(SUBSTRING_INDEX(t.TICKMODPAY, '|', -1) AS DECIMAL(10,2)))
               FROM epidatas.tickets t JOIN epicafe.membres m ON m.MBREID = t.TICKADH
              WHERE m.MBREREF = a.ADHID) cag
       FROM epicafe.adherents a WHERE a.ADHID <> 0 ORDER BY a.ADHID`,
  );
  const balances = await tx
    .select({ legacy: s.household.legacyAdhid, balance: s.householdBalance.balance })
    .from(s.household)
    .innerJoin(s.householdBalance, eq(s.householdBalance.householdId, s.household.id))
    .where(
      inArray(
        s.household.legacyAdhid,
        legacy.map((l) => l.ADHID),
      ),
    );
  const by = new Map(balances.map((b) => [b.legacy!, b.balance]));
  const rows = legacy.map((l) => {
    const old = legacyCents(l.ADHSOLDE);
    const now = legacyCents(by.get(l.ADHID) ?? 0);
    const debits = -legacyCents(l.debits ?? 0);
    const cag = legacyCents(l.cag ?? 0);
    return {
      household: l.ADHID,
      adhsolde: centsToDecimal(old),
      balance: centsToDecimal(now),
      balanceDiff: centsToDecimal(now - old),
      ticketsWallet: centsToDecimal(cag),
      debits01011: centsToDecimal(debits),
      walletDiff: centsToDecimal(cag - debits),
    };
  });
  const off = rows.filter((x) => x.balanceDiff !== '0.00' || x.walletDiff !== '0.00');
  r.counts.push({
    table: 'cagnotte',
    source: legacy.length,
    migrated: legacy.length - off.length,
    note: `${off.length} foyer(s) avec un écart à valider par le trésorier (§9.2)`,
  });
  r.sheets.push({
    name: 'Cagnottes',
    columns: [
      { header: 'Foyer (ADHID)', key: 'household', width: 12 },
      { header: 'ADHSOLDE EpiSoft', key: 'adhsolde', width: 16 },
      { header: 'Solde recalculé', key: 'balance', width: 16 },
      { header: 'Écart de solde', key: 'balanceDiff', width: 14 },
      { header: 'Payé par cagnotte (tickets)', key: 'ticketsWallet', width: 24 },
      { header: 'Débits 01011', key: 'debits01011', width: 14 },
      { header: 'Tickets − débits (C2)', key: 'walletDiff', width: 20 },
    ],
    rows,
  });
}

// --- Cagnotte debits taken from the tickets ---------------------------------------------------

/**
 * One PURCHASE per migrated ticket paid (even partly) from the cagnotte (a REFUND when the cagnotte part is negative: refund or change given back), on the buyer's household,
 * at the time of the sale: exactly what a v2 sale does. Rebuilt on each run so it stays idempotent.
 */
async function debitWalletFromTickets(tx: Tx, r: Report) {
  await tx.execute(
    sql`delete from app.wallet_entry where kind in ('PURCHASE', 'REFUND') and sale_id in (select id from app.sale where legacy_ref is not null)`,
  );
  const inserted = await tx.execute(sql`
    insert into app.wallet_entry (id, household_id, at, amount, kind, sale_id, comment)
    select gen_random_uuid(), s.household_id, s.sold_at, -sum(p.amount),
           case when sum(p.amount) > 0 then 'PURCHASE' else 'REFUND' end::app.wallet_entry_kind, s.id,
           'Ticket ' || s.number || ' (reprise EpiSoft)'
      from app.sale s join app.sale_payment p on p.sale_id = s.id and p.method = 'WALLET'
     where s.legacy_ref is not null and s.status = 'COMPLETED' and s.household_id is not null
     group by s.id, s.household_id, s.sold_at, s.number
    having sum(p.amount) <> 0`);
  const orphans = await tx.execute<{ ref: string; amount: string }>(
    sql`select s.legacy_ref as ref, sum(p.amount)::text as amount
         from app.sale s join app.sale_payment p on p.sale_id = s.id and p.method = 'WALLET'
        where s.legacy_ref is not null and s.status = 'COMPLETED' and s.household_id is null
        group by s.legacy_ref`,
  );
  for (const o of orphans.rows)
    r.issues.push({
      entity: 'ticket',
      legacyId: o.ref,
      field: 'TICKMODPAY',
      value: o.amount,
      problem: 'payé par cagnotte sans foyer connu',
      action: 'aucun débit de cagnotte',
    });
  r.counts.push({
    table: 'débit cagnotte',
    source: inserted.rowCount ?? 0,
    migrated: inserted.rowCount ?? 0,
    note: 'un débit par ticket payé par cagnotte (R-CAG-02)',
  });
}
