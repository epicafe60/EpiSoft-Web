/**
 * Legacy migration (spec §9.1). Lot 0: regions, communes, households, members, roles,
 * login log and the cash float setting. Lot 1 (lot1.ts): suppliers, catalogue, images,
 * opening stock, memberships, payments and cagnotte, tickets and sessions. Lot 2 (lot2.ts):
 * purchase orders and receipts, supplier invoices, inventory history. Lot 3 (lot3.ts):
 * accounts, journals, fiscal years, entries, reconciliations, guides, bank rules.
 *
 * - Reads the EpiSoft MariaDB with SELECT only (see source.ts); never writes to it.
 * - Idempotent: rows are matched on their legacy id and updated on each run.
 * - Runs in a single PostgreSQL transaction; --dry-run rolls it back.
 * - Writes an Excel report (counts and anomalies) into exports/.
 *
 * Usage: pnpm legacy:migrate [--dry-run] [--local | --remote] [--config FILE]
 */
import ExcelJS from 'exceljs';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  centsToDecimal,
  cleanText,
  parseAmountToCents,
  sha256Hex,
  type RoleCode,
} from '@episoft/shared';
import { createDb, createPool, loadEnv, REPO_ROOT, requireEnv, type Tx } from '../index';
import * as s from '../schema';
import { DEFAULT_LEGACY_CONFIG, openLegacySource, type LegacySource } from './source';
import {
  mergeRoles,
  PASSING_MEMBER_ID,
  qrUsage,
  transformMember,
  type Issue,
  type LegacyCommune,
  type LegacyMemberRow,
} from './transform';
import { migrateLot1, type Report } from './lot1';
import { migrateLot2 } from './lot2';
import { migrateLot3 } from './lot3';

interface Count {
  table: string;
  source: number;
  migrated: number;
  note: string;
}

class Rollback extends Error {}

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    'dry-run': { type: 'boolean', default: false },
    local: { type: 'boolean' },
    remote: { type: 'boolean' },
    config: { type: 'string' },
  },
});

loadEnv();
const configPath = args.config ?? process.env.LEGACY_CONFIG ?? DEFAULT_LEGACY_CONFIG;
const legacy = await openLegacySource({
  configPath,
  local: args.local ? true : args.remote ? false : undefined,
});
console.log(`Source : base ${legacy.description}`);
const pool = createPool(requireEnv('DATABASE_URL'), 1);
const db = createDb(pool);
const counts: Count[] = [];
const issues: Issue[] = [];
const sheets: Report['sheets'] = [];

try {
  await db.transaction(async (tx) => {
    await migrateRegionsAndCommunes(legacy, tx);
    await migrateHouseholdsAndMembers(legacy, tx);
    await migrateLogins(legacy, tx);
    await migrateParams(legacy, tx);
    await migrateLot1(legacy, tx, { counts, issues, sheets });
    await migrateLot2(legacy, tx, { counts, issues, sheets });
    await migrateLot3(legacy, tx, { counts, issues, sheets });
    if (args['dry-run']) throw new Rollback();
  });
  console.log('Migration validée.');
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log('Essai (--dry-run) : transaction annulée, rien n’a été écrit.');
} finally {
  await legacy.close();
  await pool.end();
}

for (const c of counts)
  console.log(`${c.table.padEnd(12)} source ${c.source}  repris ${c.migrated}  ${c.note}`);
console.log(`${issues.length} anomalie(s).`);
console.log(`Rapport : ${await writeReport()}`);

// ---------------------------------------------------------------------------

async function migrateRegionsAndCommunes(src: LegacySource, tx: Tx) {
  const regions = await src.query<{ REGID: string; REGNOM: string }>(
    'SELECT REGID, REGNOM FROM epicafe.regions ORDER BY REGID',
  );
  for (const r of regions) {
    const code = r.REGID.trim();
    const name = cleanText(r.REGNOM) ?? code;
    await tx
      .insert(s.region)
      .values({ code, name })
      .onConflictDoUpdate({ target: s.region.code, set: { name } });
  }
  counts.push({ table: 'région', source: regions.length, migrated: regions.length, note: '' });

  const regionIds = new Map(
    (await tx.select({ id: s.region.id, code: s.region.code }).from(s.region)).map((r) => [
      r.code,
      r.id,
    ]),
  );
  const communes = await src.query<{
    COMMUNEID: number;
    COMMUNECP: number;
    COMMUNOM: string;
    COMMUREG: number;
  }>('SELECT COMMUNEID, COMMUNECP, COMMUNOM, COMMUREG FROM epicafe.communes ORDER BY COMMUNEID');
  let noRegion = 0;
  for (const c of communes) {
    const regionId = regionIds.get(String(c.COMMUREG).padStart(2, '0')) ?? null;
    if (!regionId) noRegion++;
    const values = {
      postcode: String(c.COMMUNECP).padStart(5, '0'),
      name: cleanText(c.COMMUNOM) ?? '?',
      regionId,
      legacyCommuneId: c.COMMUNEID,
    };
    await tx
      .insert(s.commune)
      .values(values)
      .onConflictDoUpdate({ target: s.commune.legacyCommuneId, set: values });
  }
  if (noRegion > 0) {
    issues.push({
      entity: 'commune',
      legacyId: '*',
      field: 'COMMUREG',
      value: '0',
      problem: `${noRegion} commune(s) sans région valide`,
      action: 'région laissée vide',
    });
  }
  counts.push({ table: 'commune', source: communes.length, migrated: communes.length, note: '' });
}

async function migrateHouseholdsAndMembers(src: LegacySource, tx: Tx) {
  const households = await src.query<{
    ADHID: number;
    ADHDIVERS: string | null;
    ADHREFVIR: string | null;
  }>('SELECT ADHID, ADHDIVERS, ADHREFVIR FROM epicafe.adherents ORDER BY ADHID');
  const members = await src.query<
    Omit<LegacyMemberRow, 'qr'> & { MBREQRCODE: Buffer | string | null }
  >(
    `SELECT MBREID, MBRENOM, MBREPRENOM, MBREADR, MBRECPOST, MBRECITY, MBRETELEPH, MBREMAIL, MBREREF,
            MBRESTATUT, MBREPERMS, MBREVISIBLE, MBRENEWS, MBREUSERNAME, MBREQRCODE
       FROM epicafe.membres ORDER BY MBREID`,
  );
  const rows: LegacyMemberRow[] = members.map(({ MBREQRCODE, ...m }) => ({
    ...m,
    qr:
      MBREQRCODE == null
        ? null
        : Buffer.isBuffer(MBREQRCODE)
          ? MBREQRCODE.toString('utf8')
          : MBREQRCODE,
  }));

  // Households. R-MBR-10: household 0 belongs to the pseudo-member "Adhérent de passage".
  const householdIds = new Set<number>();
  const householdUuid = new Map<number, string>();
  for (const h of households) {
    if (h.ADHID === PASSING_MEMBER_ID) continue;
    householdIds.add(h.ADHID);
    const values = {
      number: h.ADHID,
      notes: cleanText(h.ADHDIVERS),
      transferReference: cleanText(h.ADHREFVIR),
      legacyAdhid: h.ADHID,
    };
    const [row] = await tx
      .insert(s.household)
      .values(values)
      .onConflictDoUpdate({ target: s.household.legacyAdhid, set: values })
      .returning({ id: s.household.id });
    householdUuid.set(h.ADHID, row!.id);
  }
  counts.push({
    table: 'foyer',
    source: households.length,
    migrated: householdIds.size,
    note: 'foyer 0 (adhérent de passage) non repris, R-MBR-10',
  });

  const communeRows = await tx
    .select({ id: s.commune.id, legacyId: s.commune.legacyCommuneId, postcode: s.commune.postcode })
    .from(s.commune)
    .where(isNotNull(s.commune.legacyCommuneId));
  const communes = new Map<number, LegacyCommune>(
    communeRows.map((c) => [c.legacyId!, { legacyId: c.legacyId!, postcode: c.postcode }]),
  );
  const communeUuid = new Map(communeRows.map((c) => [c.legacyId!, c.id]));
  const qrCounts = qrUsage(rows);
  const migrationDate = new Date();

  // Members.
  const memberUuid = new Map<number, string>();
  let migrated = 0;
  for (const r of rows) {
    if (r.MBREID === PASSING_MEMBER_ID) continue;
    const { draft, issues: found } = transformMember(r, communes, qrCounts, householdIds);
    issues.push(...found);

    const existing = await tx.query.member.findFirst({
      where: eq(s.member.legacyMbreid, draft.legacyMbreid),
      columns: { id: true, newsletterOptInAt: true },
    });
    const values = {
      number: draft.legacyMbreid,
      householdId:
        draft.legacyHouseholdId == null ? null : householdUuid.get(draft.legacyHouseholdId)!,
      lastName: draft.lastName,
      firstName: draft.firstName,
      street: draft.street,
      postcode: draft.postcode,
      communeId: draft.legacyCommuneId == null ? null : communeUuid.get(draft.legacyCommuneId)!,
      phone: draft.phone,
      email: draft.email,
      status: draft.status,
      publicVisible: draft.publicVisible,
      // §6.3: consent is dated on the (first) migration day.
      newsletterOptInAt: draft.newsletter ? (existing?.newsletterOptInAt ?? migrationDate) : null,
      username: draft.username,
      qrTokenHash: draft.qrToken ? await sha256Hex(draft.qrToken) : null,
      legacyMbreid: draft.legacyMbreid,
    };
    // Password hashes are never touched: no password is migrated (§6.3).
    const [row] = await tx
      .insert(s.member)
      .values(values)
      .onConflictDoUpdate({ target: s.member.legacyMbreid, set: values })
      .returning({ id: s.member.id });
    memberUuid.set(draft.legacyMbreid, row!.id);

    const current = (
      await tx
        .select({ code: s.userRole.roleCode })
        .from(s.userRole)
        .where(eq(s.userRole.memberId, row!.id))
    ).map((x) => x.code as RoleCode);
    const next = mergeRoles(current, draft.roles);
    await tx.delete(s.userRole).where(eq(s.userRole.memberId, row!.id));
    if (next.length > 0) {
      await tx.insert(s.userRole).values(next.map((roleCode) => ({ memberId: row!.id, roleCode })));
    }
    migrated++;
  }
  counts.push({
    table: 'membre',
    source: rows.length,
    migrated,
    note: 'membre 0 (adhérent de passage) non repris, R-MBR-10',
  });

  // Referents: in EpiSoft a household id is its referent's member id (R-MBR-02 separates them).
  for (const [adhid, hid] of householdUuid) {
    const referent = memberUuid.get(adhid) ?? null;
    if (!referent) {
      issues.push({
        entity: 'foyer',
        legacyId: String(adhid),
        field: 'ADHID',
        value: String(adhid),
        problem: 'pas de membre référent',
        action: 'référent laissé vide',
      });
    }
    await tx.update(s.household).set({ referentMemberId: referent }).where(eq(s.household.id, hid));
  }

  // Identity sequences continue after the migrated numbers.
  await tx.execute(
    sql`select setval(pg_get_serial_sequence('app.household', 'number'), greatest((select max(number) from app.household), 1))`,
  );
  await tx.execute(
    sql`select setval(pg_get_serial_sequence('app.member', 'number'), greatest((select max(number) from app.member), 1))`,
  );
}

async function migrateLogins(src: LegacySource, tx: Tx) {
  const logins = await src.query<{
    LOGID: number;
    LOGADH: number;
    LOGDATH: string;
    LOGMOD: string;
    LOGOUT: string | null;
  }>('SELECT LOGID, LOGADH, LOGDATH, LOGMOD, LOGOUT FROM epidatas.logins ORDER BY LOGID');
  const members = await tx
    .select({ id: s.member.id, legacy: s.member.legacyMbreid, username: s.member.username })
    .from(s.member)
    .where(isNotNull(s.member.legacyMbreid));
  const byLegacy = new Map(members.map((m) => [m.legacy!, m]));
  // Legacy datetimes are Paris local time.
  const paris = (v: string | null) =>
    v ? sql`(${v}::timestamp at time zone 'Europe/Paris')` : null;
  for (const l of logins) {
    const m = byLegacy.get(l.LOGADH);
    const values = {
      memberId: m?.id ?? null,
      username: m?.username ?? null,
      at: paris(l.LOGDATH)!,
      device: `EpiSoft ${l.LOGMOD}`,
      success: true,
      logoutAt: paris(l.LOGOUT),
      legacyLogid: l.LOGID,
    };
    await tx
      .insert(s.loginLog)
      .values(values)
      .onConflictDoUpdate({ target: s.loginLog.legacyLogid, set: values });
  }
  counts.push({ table: 'connexion', source: logins.length, migrated: logins.length, note: '' });
}

async function migrateParams(src: LegacySource, tx: Tx) {
  const params = await src.query<{ PARAMNAME: string; PARAMVAL: number | null }>(
    'SELECT PARAMNAME, PARAMVAL FROM epicafe.params',
  );
  const float = params.find((p) => p.PARAMNAME?.trim() === 'FOND_CAISSE');
  if (float?.PARAMVAL != null) {
    const cents = parseAmountToCents(String(float.PARAMVAL));
    if (cents !== null) {
      const value = { amount: centsToDecimal(cents) };
      await tx
        .insert(s.setting)
        .values({ key: 'pos.defaultFloat', value })
        .onConflictDoUpdate({ target: s.setting.key, set: { value } });
    }
  }
  counts.push({
    table: 'paramètre',
    source: params.length,
    migrated: float ? 1 : 0,
    note: 'FOND_CAISSE → pos.defaultFloat',
  });
}

async function writeReport(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = (
    name: string,
    columns: { header: string; key: string; width: number }[],
    rows: object[],
  ) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.addRows(rows);
  };
  sheet(
    'Comptages',
    [
      { header: 'Table', key: 'table', width: 14 },
      { header: 'Source', key: 'source', width: 10 },
      { header: 'Repris', key: 'migrated', width: 10 },
      { header: 'Remarque', key: 'note', width: 60 },
    ],
    counts,
  );
  sheet(
    'Anomalies',
    [
      { header: 'Objet', key: 'entity', width: 12 },
      { header: 'Id source', key: 'legacyId', width: 10 },
      { header: 'Champ', key: 'field', width: 14 },
      { header: 'Valeur', key: 'value', width: 28 },
      { header: 'Problème', key: 'problem', width: 44 },
      { header: 'Traitement', key: 'action', width: 36 },
    ],
    issues,
  );
  for (const extra of sheets) sheet(extra.name, extra.columns, extra.rows);
  const dir = join(REPO_ROOT, 'exports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const path = join(dir, `migration-lot0-${stamp}${args['dry-run'] ? '-essai' : ''}.xlsx`);
  await wb.xlsx.writeFile(path);
  return path;
}
