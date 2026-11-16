import { and, eq, max, sql } from 'drizzle-orm';
import { periodClosing, sale, syncRejection, type DbOrTx } from '@episoft/db';
import {
  GENESIS_HASH,
  tillSealIsConsistent,
  type SealedOp,
  type SyncWarning,
  type TillSealStatus,
} from '@episoft/shared';
import { toShopDate } from '../../lib/dates';
import { lockPeriodShared } from './journal';

// ADR 0016, §1 and §3: what the server decides about a ticket before writing it: the day it
// counts on, and whether the seal the till put on it holds.

export interface TicketFiscal {
  registerSeq: number | null;
  tillHash: string | null;
  tillPrevHash: string | null;
  tillSealStatus: TillSealStatus;
  accountingDay: string;
}

const addDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The day a document counts on. Its own day, unless that day is already closed: a Z is never
 * changed, so a ticket that arrives late (a till that was offline) counts on the first open day,
 * with its real date and number kept, and a warning.
 */
export async function accountingDayFor(
  tx: DbOrTx,
  at: Date,
  warn: (code: string, message: string) => void,
): Promise<string> {
  await lockPeriodShared(tx);
  const day = toShopDate(at);
  const [row] = await tx
    .select({ last: max(periodClosing.periodStart) })
    .from(periodClosing)
    .where(eq(periodClosing.kind, 'DAY'));
  const last = row?.last;
  if (last && day <= last) {
    warn(
      'LATE_AFTER_CLOSING',
      `Ce ticket est du ${day}, jour déjà clôturé : il est compté sur le ${addDay(last)}, avec sa date et son numéro d’origine.`,
    );
    return addDay(last);
  }
  return day;
}

/** Recomputes the till's seal and checks the register's counter and chain (never refuses the ticket). */
export async function checkTillSeal(
  tx: DbOrTx,
  deviceId: string,
  op: SealedOp,
  saleId: string,
  warn: (code: string, message: string) => void,
): Promise<Omit<TicketFiscal, 'accountingDay'>> {
  const seal = op.payload.seal;
  if (!seal)
    return { registerSeq: null, tillHash: null, tillPrevHash: null, tillSealStatus: 'ABSENT' };
  const base = { registerSeq: seal.seq, tillHash: seal.hash, tillPrevHash: seal.prev };
  const flag = (status: TillSealStatus, code: string, message: string) => {
    warn(code, message);
    return { ...base, tillSealStatus: status };
  };
  if (!(await tillSealIsConsistent(op, seal)))
    return flag(
      'INVALID',
      'SEAL_INVALID',
      `Le scellé du ticket ${op.payload.provisionalNumber} ne correspond pas à son contenu.`,
    );
  const [dup] = await tx
    .select({ id: sale.id })
    .from(sale)
    .where(
      and(
        eq(sale.deviceId, deviceId),
        eq(sale.registerSeq, seal.seq),
        sql`${sale.id} <> ${saleId}`,
      ),
    )
    .limit(1);
  if (dup)
    return flag(
      'DUPLICATE',
      'SEAL_DUPLICATE',
      `Le numéro de caisse ${op.payload.provisionalNumber} a déjà servi.`,
    );
  if (seal.seq === 1)
    return seal.prev === GENESIS_HASH
      ? { ...base, tillSealStatus: 'OK' }
      : flag(
          'BROKEN_LINK',
          'SEAL_BROKEN_LINK',
          'Le premier ticket du poste ne part pas de l’origine.',
        );
  const [before] = await tx
    .select({ hash: sale.tillHash })
    .from(sale)
    .where(and(eq(sale.deviceId, deviceId), eq(sale.registerSeq, seal.seq - 1)))
    .limit(1);
  if (before)
    return before.hash === seal.prev
      ? { ...base, tillSealStatus: 'OK' }
      : flag(
          'BROKEN_LINK',
          'SEAL_BROKEN_LINK',
          `Le ticket ${op.payload.provisionalNumber} ne suit pas le précédent du poste.`,
        );
  // The one before may have been refused (kept, with its seal, in the rejections).
  const [refused] = await tx
    .select({ id: syncRejection.id })
    .from(syncRejection)
    .where(
      and(
        eq(syncRejection.deviceId, deviceId),
        sql`(${syncRejection.payload} -> 'seal' ->> 'seq')::int = ${seal.seq - 1}`,
      ),
    )
    .limit(1);
  if (refused) return { ...base, tillSealStatus: 'OK' };
  return flag(
    'GAP',
    'SEAL_GAP',
    `Il manque un document du poste avant ${op.payload.provisionalNumber} (numéro de caisse non consécutif).`,
  );
}

export type WarnFn = (code: string, message: string) => void;
export type { SyncWarning };
