import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { account, entry, entryLine, fiscalYear, journal, type Db, type DbOrTx } from '@episoft/db';
import {
  buildFec,
  checkFec,
  decimalToCents,
  formatEntryNumber,
  type FecAnomaly,
  type FecCheckEntry,
  type FecLine,
} from '@episoft/shared';
import type { Config } from '../../config';
import { toShopDate } from '../../lib/dates';
import { conflict, notFound } from '../../lib/problem';
import { loadSettings } from '../admin/settings-store';

type FiscalYearRow = typeof fiscalYear.$inferSelect;

/**
 * Everything the FEC needs for a fiscal year: the lines of its entries (drafts included, so that
 * the self-check can report them) in the order of the file, and the entries for the checks.
 */
export async function loadFecData(db: DbOrTx, fy: FiscalYearRow) {
  const rows = await db
    .select({
      entryId: entry.id,
      code: journal.code,
      journalLabel: journal.label,
      number: entry.number,
      status: entry.status,
      date: entry.date,
      account: account.number,
      accountLabel: account.label,
      pieceRef: entry.pieceRef,
      entryLabel: entry.label,
      label: entryLine.label,
      debit: entryLine.debit,
      credit: entryLine.credit,
      lettering: entryLine.letteringCode,
      letteredOn: entryLine.letteredOn,
      validatedAt: entry.validatedAt,
    })
    .from(entryLine)
    .innerJoin(entry, eq(entry.id, entryLine.entryId))
    .innerJoin(journal, eq(journal.id, entry.journalId))
    .innerJoin(account, eq(account.id, entryLine.accountId))
    .where(eq(entry.fiscalYearId, fy.id))
    .orderBy(asc(journal.code), asc(entry.number), asc(entryLine.lineNo));
  const year = Number(fy.startDate.slice(0, 4));
  const byEntry = new Map<string, FecCheckEntry>();
  const lines: FecLine[] = [];
  for (const r of rows) {
    const validatedOn = r.validatedAt ? toShopDate(r.validatedAt) : null;
    let e = byEntry.get(r.entryId);
    if (!e) {
      e = {
        id: r.entryId,
        journalCode: r.code,
        number: r.number,
        date: r.date,
        status: r.status,
        pieceRef: r.pieceRef,
        label: r.entryLabel,
        validatedOn,
        lines: [],
      };
      byEntry.set(r.entryId, e);
    }
    const debitCents = decimalToCents(r.debit);
    const creditCents = decimalToCents(r.credit);
    e.lines.push({ label: r.label, debitCents, creditCents });
    if (r.status === 'VALIDATED' && r.number !== null)
      lines.push({
        journalCode: r.code,
        journalLabel: r.journalLabel,
        entryNumber: formatEntryNumber(r.code, year, r.number),
        date: r.date,
        account: r.account,
        accountLabel: r.accountLabel,
        pieceRef: r.pieceRef,
        label: r.label,
        debitCents,
        creditCents,
        lettering: r.lettering,
        letteredOn: r.letteredOn,
        validatedOn: validatedOn ?? r.date,
      });
  }
  return { entries: [...byEntry.values()], lines };
}

export const fecRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (app, { db }) => {
  const compta = { preHandler: app.requireRoles('COMPTA') };
  const params = { params: z.object({ fiscalYearId: z.string().uuid() }) };

  const selfCheck = async (fy: FiscalYearRow) => {
    const data = await loadFecData(db, fy);
    const siren = (await loadSettings(db))['association.identity'].siren ?? null;
    const anomalies: FecAnomaly[] = checkFec({
      entries: data.entries,
      startDate: fy.startDate,
      endDate: fy.endDate,
      siren,
    });
    return { data, siren, anomalies };
  };

  /**
   * FEC self-check (art. A47 A-1 LPF): what the tax auditor's tool would reject, listed before the
   * file is handed over. Errors block the export; warnings are only shown.
   */
  app.get('/reports/fec/:fiscalYearId/check', { ...compta, schema: params }, async (req) => {
    const [fy] = await db
      .select()
      .from(fiscalYear)
      .where(eq(fiscalYear.id, req.params.fiscalYearId));
    if (!fy) throw notFound('Exercice introuvable.');
    const { data, anomalies } = await selfCheck(fy);
    return {
      fiscalYear: fy.label,
      entries: data.entries.length,
      lines: data.lines.length,
      ok: !anomalies.some((a) => a.severity === 'error'),
      anomalies,
    };
  });

  /**
   * FEC (R-CPT-19): validated entries of a fiscal year, 18 columns, tab-separated. The export is
   * refused while the self-check finds an error (drafts, unbalanced entry, gap in the numbering…).
   */
  app.get('/reports/fec/:fiscalYearId', { ...compta, schema: params }, async (req, reply) => {
    const [fy] = await db
      .select()
      .from(fiscalYear)
      .where(eq(fiscalYear.id, req.params.fiscalYearId));
    if (!fy) throw notFound('Exercice introuvable.');
    const { data, siren, anomalies } = await selfCheck(fy);
    const blocking = anomalies.filter((a) => a.severity === 'error');
    if (blocking.length)
      throw conflict(
        `Le FEC ne peut pas être produit : ${blocking[0]!.message}${blocking.length > 1 ? ` (et ${blocking.length - 1} autre(s) anomalie(s) : voir le contrôle du FEC)` : ''}`,
      );
    const name = siren ? siren.replace(/\s/g, '') : 'SIREN';
    return reply
      .header(
        'content-disposition',
        `attachment; filename="${name}FEC${fy.endDate.replaceAll('-', '')}.txt"`,
      )
      .type('text/plain; charset=utf-8')
      .send(buildFec(data.lines));
  });
};
