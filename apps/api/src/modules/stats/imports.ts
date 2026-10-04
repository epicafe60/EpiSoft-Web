import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  household,
  householdBalance,
  importLog,
  importMapping,
  member,
  product,
  productBarcode,
  priceHistory,
  supplier,
  walletEntry,
  type Db,
  type Tx,
} from '@episoft/db';
import {
  EPICERIO_COLUMNS,
  IMPORT_FIELDS,
  IMPORT_KINDS,
  PRODUCT_UPDATE_FIELDS,
  autoMapColumns,
  centsToDecimal,
  hasAnyRole,
  inclFromExcl4,
  looksLikeHeader,
  milliToDecimal,
  normalizeMember,
  normalizeProduct,
  parseImportCsv,
  price4ToDecimal,
  toRecords,
  type ImportKind,
  type MemberImport,
  type ProductImport,
  type ProductUpdateField,
} from '@episoft/shared';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, forbidden } from '../../lib/problem';
import { recordMovement } from '../stock/ledger';

const MAX_FILE = 10 * 1024 * 1024;
const PREVIEW_ROWS = 300;

const params = z.object({ kind: z.enum(IMPORT_KINDS) });
const query = z.object({
  profile: z.enum(['epicerio', 'custom']).default('epicerio'),
  /** custom profile: JSON {field: columnIndex}; omitted = automatic mapping by header. */
  mapping: z.string().optional(),
  /** products: comma list of purchasePrice,salePrice,stock to overwrite on existing products. */
  fields: z.string().default(''),
  /** products: JSON {supplierNameInFile: supplierId}, remembered for next imports. */
  supplierMap: z.string().optional(),
  /** members: apply balance corrections (R-IMP-02). */
  confirmBalance: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const ROLE_FOR: Record<ImportKind, 'PRODUITS' | 'ADHERENTS'> = {
  products: 'PRODUITS',
  members: 'ADHERENTS',
};

function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** CSV or XLSX (first sheet) as rows of strings. */
async function readTable(buf: Buffer, fileName: string): Promise<string[][]> {
  if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('Classeur vide.');
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as unknown[]).slice(1).map((v) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && 'result' in (v as object))
          return String((v as { result: unknown }).result ?? '');
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return String(v);
      });
      rows.push(values);
    });
    return rows;
  }
  return parseImportCsv(decodeText(buf));
}

export interface PlanRow {
  line: number;
  label: string;
  action: 'create' | 'update' | 'unchanged' | 'error';
  changes: Record<string, { from: string | null; to: string | null }>;
  error?: string;
}

const price4Str = (p: number | null) => (p === null ? null : price4ToDecimal(p));

export const importRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_FILE },
    (_req, body, done) => done(null, body),
  );

  /** Table → typed records, following the chosen profile. */
  async function load(kind: ImportKind, req: { body: unknown; headers: Record<string, unknown> }, q: z.infer<typeof query>) {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw badRequest('Fichier absent : envoyez-le en application/octet-stream.');
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'import.csv'));
    const table = await readTable(body, fileName);
    if (table.length === 0) throw badRequest('Le fichier est vide.');
    let headers: string[];
    let rows: string[][];
    let mapping: Record<string, number>;
    if (q.profile === 'epicerio') {
      const hasHeader = looksLikeHeader(table[0]!, kind);
      headers = hasHeader ? table[0]! : [];
      rows = hasHeader ? table.slice(1) : table;
      mapping = EPICERIO_COLUMNS[kind];
    } else {
      headers = table[0]!;
      rows = table.slice(1);
      mapping = q.mapping ? (JSON.parse(q.mapping) as Record<string, number>) : autoMapColumns(headers, kind);
    }
    const missing = IMPORT_FIELDS[kind].filter((f) => f.required && mapping[f.key] === undefined);
    if (missing.length)
      throw badRequest(`Colonnes à associer : ${missing.map((f) => f.label).join(', ')}.`);
    return {
      body,
      fileName,
      hash: createHash('sha256').update(body).digest('hex'),
      headers,
      mapping,
      records: toRecords(rows, mapping),
    };
  }

  // --- Products (R-IMP-01) ----------------------------------------------------------------------

  async function supplierResolver(tx: Db | Tx, names: string[], explicit: Record<string, string>) {
    const known = await tx.select({ id: supplier.id, name: supplier.name }).from(supplier);
    const remembered = await tx
      .select({ key: importMapping.sourceKey, target: importMapping.target })
      .from(importMapping)
      .where(eq(importMapping.kind, 'SUPPLIER'));
    const byName = new Map(known.map((s) => [s.name.trim().toLowerCase(), s.id]));
    const byMemory = new Map(remembered.map((m) => [m.key, m.target]));
    const resolved = new Map<string, string>();
    const unknown = new Set<string>();
    for (const n of names) {
      const id = explicit[n] ?? byMemory.get(n.toLowerCase()) ?? byName.get(n.toLowerCase());
      if (id) resolved.set(n, id);
      else unknown.add(n);
    }
    return { resolved, unknown: [...unknown].sort() };
  }

  async function planProducts(
    tx: Db | Tx,
    records: Record<string, string>[],
    supplierMap: Record<string, string>,
  ) {
    const parsed = records.map((r, i) => ({ line: i + 1, ...normalizeProduct(r) }));
    const codes = parsed.flatMap((p) => (p.value ? [p.value.code] : []));
    const existing = codes.length
      ? await tx.select().from(product).where(inArray(product.code, codes))
      : [];
    const byCode = new Map(existing.map((p) => [p.code, p]));
    const eans = parsed.flatMap((p) => (p.value?.ean ? [p.value.ean] : []));
    const barcodes = eans.length
      ? await tx.select().from(productBarcode).where(inArray(productBarcode.ean, eans))
      : [];
    const byId = new Map(
      eans.length
        ? (
            await tx
              .select()
              .from(product)
              .where(inArray(product.id, barcodes.map((b) => b.productId)))
          ).map((p) => [p.id, p])
        : [],
    );
    const byEan = new Map(barcodes.map((b) => [b.ean, byId.get(b.productId)]));
    const suppliers = await supplierResolver(
      tx,
      [...new Set(parsed.flatMap((p) => (p.value?.supplierName ? [p.value.supplierName] : [])))],
      supplierMap,
    );

    const plan: (PlanRow & { value?: ProductImport; existing?: typeof product.$inferSelect })[] = [];
    const seen = new Set<string>();
    for (const p of parsed) {
      if (!p.value) {
        plan.push({ line: p.line, label: '', action: 'error', changes: {}, error: p.error! });
        continue;
      }
      const v = p.value;
      if (seen.has(v.code)) {
        plan.push({ line: p.line, label: v.code, action: 'error', changes: {}, error: 'Code en double dans le fichier.' });
        continue;
      }
      seen.add(v.code);
      const cur = byCode.get(v.code) ?? (v.ean ? byEan.get(v.ean) : undefined);
      const label = `${v.code} — ${v.name}`;
      if (!cur) {
        plan.push({ line: p.line, label, action: 'create', changes: {}, value: v });
        continue;
      }
      const changes: PlanRow['changes'] = {};
      if (v.purchaseExcl4 !== null) {
        const now = cur.purchasePriceExcl === null ? null : Math.round(Number(cur.purchasePriceExcl) * 10_000);
        if (now !== v.purchaseExcl4)
          changes.purchasePrice = { from: cur.purchasePriceExcl, to: price4Str(v.purchaseExcl4) };
      }
      if (v.salePriceCents !== null && Math.round(Number(cur.salePrice) * 100) !== v.salePriceCents)
        changes.salePrice = { from: cur.salePrice, to: centsToDecimal(v.salePriceCents) };
      if (v.stockMilli !== null && Math.round(Number(cur.stockQty) * 1000) !== v.stockMilli)
        changes.stock = { from: cur.stockQty, to: milliToDecimal(v.stockMilli) };
      plan.push({
        line: p.line,
        label,
        action: Object.keys(changes).length ? 'update' : 'unchanged',
        changes,
        value: v,
        existing: cur,
      });
    }
    return { plan, unknownSuppliers: suppliers.unknown, supplierIds: suppliers.resolved };
  }

  // --- Members (R-IMP-02) -----------------------------------------------------------------------

  async function planMembers(tx: Db | Tx, records: Record<string, string>[]) {
    const parsed = records.map((r, i) => ({ line: i + 1, ...normalizeMember(r) }));
    const all = await tx.select().from(member);
    const bal = await tx.select().from(householdBalance);
    const balanceOf = new Map(bal.map((b) => [b.householdId, Math.round(Number(b.balance) * 100)]));
    const byEmail = new Map(all.flatMap((m) => (m.email ? [[m.email.toLowerCase(), m] as const] : [])));
    const byUser = new Map(all.flatMap((m) => (m.username ? [[m.username.toLowerCase(), m] as const] : [])));
    const byName = new Map(all.map((m) => [`${m.lastName} ${m.firstName}`.toLowerCase(), m]));
    const plan: (PlanRow & { value?: MemberImport; existing?: typeof member.$inferSelect; currentBalance?: number })[] = [];
    const taken = new Set<string>();
    for (const p of parsed) {
      if (!p.value) {
        plan.push({ line: p.line, label: '', action: 'error', changes: {}, error: p.error! });
        continue;
      }
      const v = p.value;
      const label = `${v.lastName} ${v.firstName}`;
      const cur =
        (v.email ? byEmail.get(v.email) : undefined) ??
        (v.username ? byUser.get(v.username.toLowerCase()) : undefined) ??
        byName.get(label.toLowerCase());
      const clash = [v.email, v.username?.toLowerCase()].filter(Boolean).find((k) => taken.has(k!));
      if (clash) {
        plan.push({ line: p.line, label, action: 'error', changes: {}, error: 'Courriel ou identifiant en double dans le fichier.' });
        continue;
      }
      for (const k of [v.email, v.username?.toLowerCase()]) if (k) taken.add(k);
      if (!cur) {
        // A free email or username may still belong to someone matched by another key.
        const other = (v.email && byEmail.get(v.email)) || (v.username && byUser.get(v.username.toLowerCase()));
        if (other) {
          plan.push({ line: p.line, label, action: 'error', changes: {}, error: 'Courriel ou identifiant déjà utilisé.' });
          continue;
        }
        plan.push({ line: p.line, label, action: 'create', changes: v.balanceCents ? { balance: { from: '0.00', to: centsToDecimal(v.balanceCents) } } : {}, value: v, currentBalance: 0 });
        continue;
      }
      const changes: PlanRow['changes'] = {};
      if (v.email && v.email !== cur.email?.toLowerCase()) changes.email = { from: cur.email, to: v.email };
      if (v.phone && v.phone !== (cur.phone ?? '').replace(/\s/g, '')) changes.phone = { from: cur.phone, to: v.phone };
      const current = cur.householdId ? (balanceOf.get(cur.householdId) ?? 0) : 0;
      if (v.balanceCents !== null && v.balanceCents !== current)
        changes.balance = { from: centsToDecimal(current), to: centsToDecimal(v.balanceCents) };
      plan.push({
        line: p.line,
        label,
        action: Object.keys(changes).length ? 'update' : 'unchanged',
        changes,
        value: v,
        existing: cur,
        currentBalance: current,
      });
    }
    return { plan };
  }

  function counts(plan: PlanRow[]) {
    const c = { create: 0, update: 0, unchanged: 0, error: 0 };
    for (const r of plan) c[r.action]++;
    return c;
  }

  const strip = ({ line, label, action, changes, error }: PlanRow): PlanRow => ({
    line,
    label,
    action,
    changes,
    ...(error ? { error } : {}),
  });

  function guard(kind: ImportKind, roles: Parameters<typeof hasAnyRole>[0]) {
    if (!hasAnyRole(roles, [ROLE_FOR[kind]])) throw forbidden();
  }

  /** Dry run: what would change, nothing is written. */
  app.post('/imports/:kind/preview', { schema: { params, querystring: query } }, async (req) => {
    const kind = req.params.kind;
    guard(kind, req.user!.roles);
    const file = await load(kind, req, req.query);
    const supplierMap = req.query.supplierMap ? (JSON.parse(req.query.supplierMap) as Record<string, string>) : {};
    const out =
      kind === 'products'
        ? await planProducts(db, file.records, supplierMap)
        : { ...(await planMembers(db, file.records)), unknownSuppliers: [] as string[] };
    return {
      fileName: file.fileName,
      headers: file.headers,
      mapping: file.mapping,
      counts: counts(out.plan),
      unknownSuppliers: out.unknownSuppliers,
      rows: out.plan.filter((r) => r.action !== 'unchanged').slice(0, PREVIEW_ROWS).map(strip),
    };
  });

  /** Applies the plan in one transaction and journals it (R-IMP-04). Replaying changes nothing. */
  app.post('/imports/:kind/apply', { schema: { params, querystring: query } }, async (req) => {
    const kind = req.params.kind;
    guard(kind, req.user!.roles);
    const file = await load(kind, req, req.query);
    const fields = new Set(
      req.query.fields.split(',').filter((f): f is ProductUpdateField =>
        (PRODUCT_UPDATE_FIELDS as readonly string[]).includes(f),
      ),
    );
    const supplierMap = req.query.supplierMap ? (JSON.parse(req.query.supplierMap) as Record<string, string>) : {};
    return db.transaction(async (tx) => {
      const result = { created: 0, updated: 0, unchanged: 0, errors: 0, stockCorrections: 0, balanceCorrections: 0 };
      for (const [name, id] of Object.entries(supplierMap)) {
        await tx
          .insert(importMapping)
          .values({ kind: 'SUPPLIER', sourceKey: name.toLowerCase(), target: id })
          .onConflictDoUpdate({
            target: [importMapping.kind, importMapping.sourceKey],
            set: { target: id, updatedAt: sql`now()` },
          });
      }
      if (kind === 'products') {
        const { plan, supplierIds } = await planProducts(tx, file.records, supplierMap);
        for (const r of plan) {
          const v = r.value;
          if (r.action === 'error' || !v) {
            result.errors++;
            continue;
          }
          const supplierId = v.supplierName ? (supplierIds.get(v.supplierName) ?? null) : null;
          if (r.action === 'create') {
            const vat = v.vatRate === null ? '0' : String(v.vatRate);
            const [created] = await tx
              .insert(product)
              .values({
                code: v.code,
                name: v.name,
                description: v.description,
                supplierId,
                supplierRef: v.supplierRef,
                vatRate: vat,
                purchasePriceExcl: price4Str(v.purchaseExcl4),
                purchasePriceIncl: v.purchaseExcl4 === null ? null : price4ToDecimal(inclFromExcl4(v.purchaseExcl4, vat)),
                salePrice: centsToDecimal(v.salePriceCents ?? 0),
                labelPending: true,
              })
              .returning();
            if (v.ean) await tx.insert(productBarcode).values({ ean: v.ean, productId: created!.id }).onConflictDoNothing();
            await tx.insert(priceHistory).values({
              productId: created!.id,
              purchasePriceExcl: created!.purchasePriceExcl,
              purchasePriceIncl: created!.purchasePriceIncl,
              salePrice: created!.salePrice,
              source: 'IMPORT',
              by: req.user!.id,
            });
            if (v.stockMilli) {
              await recordMovement(tx, {
                productId: created!.id,
                qtyMilli: v.stockMilli,
                kind: 'INITIAL',
                unitCost: created!.purchasePriceExcl,
                by: req.user!.id,
                sourceType: 'import',
              });
            }
            result.created++;
            continue;
          }
          const cur = r.existing!;
          const apply = (f: ProductUpdateField) => fields.has(f) && r.changes[f];
          if (!apply('purchasePrice') && !apply('salePrice') && !apply('stock')) {
            result.unchanged++;
            continue;
          }
          const set: Partial<typeof product.$inferInsert> = {};
          if (apply('purchasePrice')) {
            set.purchasePriceExcl = price4Str(v.purchaseExcl4);
            set.purchasePriceIncl = price4ToDecimal(inclFromExcl4(v.purchaseExcl4!, cur.vatRate));
          }
          if (apply('salePrice')) {
            set.salePrice = centsToDecimal(v.salePriceCents!);
            set.labelPending = true;
          }
          if (Object.keys(set).length) {
            await tx.update(product).set(set).where(eq(product.id, cur.id));
            await tx.insert(priceHistory).values({
              productId: cur.id,
              purchasePriceExcl: set.purchasePriceExcl ?? cur.purchasePriceExcl,
              purchasePriceIncl: set.purchasePriceIncl ?? cur.purchasePriceIncl,
              salePrice: set.salePrice ?? cur.salePrice,
              source: 'IMPORT',
              by: req.user!.id,
            });
          }
          if (apply('stock')) {
            // R-IMP-01: a CORRECTION movement of the difference, never a silent overwrite.
            await recordMovement(tx, {
              productId: cur.id,
              qtyMilli: v.stockMilli! - Math.round(Number(cur.stockQty) * 1000),
              kind: 'CORRECTION',
              unitCost: cur.purchasePriceExcl,
              comment: `Import ${file.fileName}`,
              by: req.user!.id,
              sourceType: 'import',
            });
            result.stockCorrections++;
          }
          result.updated++;
        }
      } else {
        const { plan } = await planMembers(tx, file.records);
        for (const r of plan) {
          const v = r.value;
          if (r.action === 'error' || !v) {
            result.errors++;
            continue;
          }
          let householdId = r.existing?.householdId ?? null;
          if (r.action === 'create') {
            const [h] = await tx.insert(household).values({}).returning({ id: household.id });
            householdId = h!.id;
            const [m] = await tx
              .insert(member)
              .values({
                firstName: v.firstName,
                lastName: v.lastName,
                email: v.email,
                phone: v.phone,
                username: v.username,
                householdId,
              })
              .returning();
            await tx.update(household).set({ referentMemberId: m!.id }).where(eq(household.id, householdId));
            result.created++;
          } else if (r.action === 'update' && (r.changes.email || r.changes.phone)) {
            await tx
              .update(member)
              .set({ ...(r.changes.email ? { email: v.email } : {}), ...(r.changes.phone ? { phone: v.phone } : {}) })
              .where(eq(member.id, r.existing!.id));
            result.updated++;
          } else result.unchanged++;
          // R-IMP-02: the imported balance is compared, and an explicit CORRECTION fixes the gap.
          if (r.changes.balance && req.query.confirmBalance && householdId) {
            await tx.insert(walletEntry).values({
              householdId,
              amount: centsToDecimal(v.balanceCents! - (r.currentBalance ?? 0)),
              kind: 'CORRECTION',
              comment: `Import ${file.fileName}`,
              createdBy: req.user!.id,
            });
            result.balanceCorrections++;
          }
        }
      }
      await tx.insert(importLog).values({
        kind,
        fileName: file.fileName,
        fileHash: file.hash,
        summary: { profile: req.query.profile, fields: [...fields], ...result },
        createdBy: req.user!.id,
      });
      await audit(tx, req, { action: 'import.apply', entity: 'import', after: { kind, fileName: file.fileName, ...result } });
      return result;
    });
  });

  app.get('/imports/history', async (req) => {
    if (!hasAnyRole(req.user!.roles, ['PRODUITS', 'ADHERENTS'])) throw forbidden();
    return db
      .select()
      .from(importLog)
      .orderBy(sql`${importLog.createdAt} desc`)
      .limit(50);
  });
};
