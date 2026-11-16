import { sha256Hex } from './crypto';
import { centsToDecimal, decimalToCents } from './money';
import { parseQtyToMilli } from './pos';
import type { SyncOp } from './sync';

// ADR 0016: the till is inalterable (art. 286 I 3° bis CGI, NF525). Everything here is pure: the
// till (offline) and the server compute the very same hashes from the very same canonical text.

// --- Canonical form -------------------------------------------------------------------

/** « 2.50 » and « 2.5 » are the same amount: decimals are written without useless zeros. */
export function normDecimal(v: string | number): string {
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const neg = s.startsWith('-');
  let [int, frac = ''] = (neg ? s.slice(1) : s).split('.') as [string, string?];
  int = int.replace(/^0+(?=\d)/, '');
  frac = (frac ?? '').replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : int;
  return neg && body !== '0' ? `-${body}` : body;
}

/** An instant as ISO 8601 UTC to the millisecond, whatever the offset it was written with. */
export function normInstant(v: string | Date): string {
  return new Date(v).toISOString();
}

/**
 * Deterministic JSON: keys sorted, no space, undefined dropped. Two systems that build the same
 * object write the same bytes, so they get the same hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The hash that opens every chain. */
export const GENESIS_HASH = '0'.repeat(64);

/** hash = SHA-256(previous hash | canonical text). */
export function chainHash(prevHash: string, text: string): Promise<string> {
  return sha256Hex(`${prevHash}|${text}`);
}

/** HMAC-SHA256 as lowercase hex (Web Crypto, browser and Node 22). */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

// --- The till's seal (offline) --------------------------------------------------------

export interface TillSeal {
  /** Rank of the document in the register's gapless counter. */
  seq: number;
  prev: string;
  hash: string;
}

export const SEALED_KINDS = ['SALE', 'SALE_CANCEL', 'SALE_RETURN'] as const;
export type SealedOp = Extract<SyncOp, { kind: (typeof SEALED_KINDS)[number] }>;
export const isSealedOp = (op: SyncOp): op is SealedOp =>
  (SEALED_KINDS as readonly string[]).includes(op.kind);

/** « CAISSE1-000123 »: the number printed on the ticket (ADR 0016, §1). */
export function registerNumber(deviceName: string, seq: number): string {
  return `${deviceName}-${String(seq).padStart(6, '0')}`;
}

/** What the till vouches for: the document as the customer sees it, without the seal itself. */
export function tillSealFields(op: SealedOp, seq: number): Record<string, unknown> {
  const p = op.payload;
  const common = {
    v: 1,
    doc: op.kind,
    id: op.id,
    no: p.provisionalNumber,
    seq,
    session: p.sessionId,
    cashier: p.cashierId,
  };
  switch (op.kind) {
    case 'SALE':
      return {
        ...common,
        at: normInstant(op.payload.soldAt),
        member: op.payload.memberId,
        total: normDecimal(op.payload.total),
        lines: op.payload.lines.map((l) => ({
          p: l.productId,
          q: normDecimal(l.qty),
          u: normDecimal(l.unitPrice),
          d: normDecimal(l.discount),
        })),
        payments: op.payload.payments.map((x) => ({
          m: x.method,
          a: normDecimal(x.amount),
          t: x.tendered == null ? null : normDecimal(x.tendered),
          c: x.change == null ? null : normDecimal(x.change),
          w: x.changeToWallet ?? false,
        })),
      };
    case 'SALE_CANCEL':
      return {
        ...common,
        at: normInstant(op.payload.at),
        sale: op.payload.saleId,
        reason: op.payload.reason ?? null,
      };
    case 'SALE_RETURN':
      return {
        ...common,
        at: normInstant(op.payload.at),
        sale: op.payload.saleId,
        reason: op.payload.reason,
        refund: op.payload.refundMethod,
        restock: op.payload.restock,
        lines: op.payload.lines.map((l) => ({ n: l.lineNo, q: normDecimal(l.qty) })),
      };
  }
}

export function tillSealHash(op: SealedOp, seq: number, prev: string): Promise<string> {
  return chainHash(prev, canonicalJson(tillSealFields(op, seq)));
}

/** The seal the till attaches to a document: its rank, the previous hash and its own. */
export async function sealOp(op: SealedOp, seq: number, prev: string): Promise<TillSeal> {
  return { seq, prev, hash: await tillSealHash(op, seq, prev) };
}

export type TillSealStatus = 'OK' | 'ABSENT' | 'INVALID' | 'GAP' | 'BROKEN_LINK' | 'DUPLICATE';

/** Self-consistency of a seal: the hash is the one of the document and of the declared link. */
export async function tillSealIsConsistent(op: SealedOp, seal: TillSeal): Promise<boolean> {
  return (
    (await tillSealHash(op, seal.seq, seal.prev)) === seal.hash &&
    op.payload.provisionalNumber.endsWith(`-${String(seal.seq).padStart(6, '0')}`)
  );
}

// --- The server's journal (global chain) ---------------------------------------------

export interface JournalRow {
  seq: number;
  /** ISO 8601 UTC, millisecond. */
  at: string;
  kind: string;
  data: unknown;
  prevHash: string;
  hash: string;
  signature: string | null;
}

export function journalHash(r: Pick<JournalRow, 'seq' | 'at' | 'kind' | 'data' | 'prevHash'>) {
  return chainHash(
    r.prevHash,
    canonicalJson({ seq: r.seq, at: normInstant(r.at), kind: r.kind, data: r.data }),
  );
}

export interface ChainBreak {
  seq: number;
  problem: 'GAP' | 'LINK' | 'HASH' | 'SIGNATURE' | 'UNSIGNED';
  detail: string;
}

/**
 * Recomputes a stretch of the journal. `startPrev`: the hash the first row must follow (omit it
 * for a stretch taken in the middle of the chain). With a key, signatures are checked too.
 */
export async function verifyJournalChain(
  rows: readonly JournalRow[],
  opts: { key?: string | null; startPrev?: string } = {},
): Promise<ChainBreak[]> {
  const breaks: ChainBreak[] = [];
  let prev: JournalRow | null = null;
  for (const r of rows) {
    if (prev) {
      if (r.seq !== prev.seq + 1)
        breaks.push({
          seq: r.seq,
          problem: 'GAP',
          detail: `le rang ${r.seq} suit le rang ${prev.seq} : il manque des entrées`,
        });
      if (r.prevHash !== prev.hash)
        breaks.push({ seq: r.seq, problem: 'LINK', detail: 'l’empreinte précédente ne correspond pas' });
    } else if (opts.startPrev !== undefined && r.prevHash !== opts.startPrev) {
      breaks.push({ seq: r.seq, problem: 'LINK', detail: 'la première entrée ne suit pas l’origine' });
    }
    if ((await journalHash(r)) !== r.hash)
      breaks.push({
        seq: r.seq,
        problem: 'HASH',
        detail: 'le contenu ne correspond plus à son empreinte',
      });
    if (opts.key) {
      if (!r.signature)
        breaks.push({ seq: r.seq, problem: 'UNSIGNED', detail: 'entrée non signée' });
      else if ((await hmacSha256Hex(opts.key, r.hash)) !== r.signature)
        breaks.push({ seq: r.seq, problem: 'SIGNATURE', detail: 'signature invalide' });
    }
    prev = r;
  }
  return breaks;
}

// --- Cash payment ceiling -------------------------------------------------------------

/**
 * Art. D112-3 du code monétaire et financier: a payment in cash cannot exceed 1 000 € when the
 * payer is a consumer resident in France (15 000 € for a non-resident). The till refuses a cash
 * payment above it; the back office refuses a supplier payment in cash above it (lot D).
 */
export const CASH_PAYMENT_LIMIT_CENTS = 100_000;
export const CASH_PAYMENT_LIMIT_NON_RESIDENT_CENTS = 1_500_000;
export const CASH_PAYMENT_LIMIT_REFERENCE = 'art. D112-3 du code monétaire et financier';

/** A reason to refuse a cash payment of this amount, or null. */
export function cashPaymentProblem(
  cashCents: number,
  opts: { resident?: boolean } = {},
): string | null {
  const limit =
    opts.resident === false ? CASH_PAYMENT_LIMIT_NON_RESIDENT_CENTS : CASH_PAYMENT_LIMIT_CENTS;
  if (cashCents <= limit) return null;
  return `Un paiement en espèces ne peut dépasser ${centsToDecimal(limit)} € (${CASH_PAYMENT_LIMIT_REFERENCE}) : réglez le surplus par un autre moyen.`;
}

// --- Credit notes (partial returns) ---------------------------------------------------

/**
 * The refund of `returnQtyMilli` of a ticket line. The price and the discount are taken pro rata;
 * the last fraction takes what is left, so that the refunds of a line never exceed what was sold
 * and add up to it exactly. Returns an error message instead of an amount when it is too much.
 */
export function returnLineRefund(a: {
  lineTotalCents: number;
  qtyMilli: number;
  returnedQtyMilli: number;
  returnedCents: number;
  returnQtyMilli: number;
}): { cents: number } | { error: string } {
  if (a.returnQtyMilli <= 0) return { error: 'La quantité à rembourser doit être positive.' };
  const left = a.qtyMilli - a.returnedQtyMilli;
  if (a.returnQtyMilli > left)
    return {
      error: `Quantité à rembourser trop grande : il reste ${left / 1000} à rembourser sur cette ligne.`,
    };
  if (a.returnQtyMilli === left) return { cents: a.lineTotalCents - a.returnedCents };
  return { cents: Math.round((a.lineTotalCents * a.returnQtyMilli) / a.qtyMilli) };
}

export function parseReturnQty(q: string): number | null {
  const m = parseQtyToMilli(q);
  return m !== null && m > 0 ? m : null;
}

// --- Period closing totals ------------------------------------------------------------

export interface ClosingDoc {
  number: string;
  kind: 'SALE' | 'CANCEL' | 'RETURN';
  totalCents: number;
  /** Line totals (TTC) by VAT rate. */
  vat: { rate: string; cents: number }[];
  payments: { method: string; cents: number }[];
}

export interface PeriodVatLine {
  rate: string;
  /** Net TTC of the period at this rate (returns subtracted). */
  ttc: string;
  /** Lot B plugs the split here: nothing is computed in this module. */
  ht?: string;
  vat?: string;
}

export interface PeriodTotals {
  tickets: number;
  cancellations: number;
  returns: number;
  /** Sum of the sales. */
  salesTotal: string;
  /** Sum of what cancellations and credit notes gave back (positive). */
  refundsTotal: string;
  /** Sales minus refunds. */
  netTotal: string;
  /** Sum of the absolute values of every document: what the perpetual grand total adds. */
  absoluteTotal: string;
  byVat: PeriodVatLine[];
  byMethod: Record<string, string>;
  firstNumber: string | null;
  lastNumber: string | null;
}

export function computePeriodTotals(docs: readonly ClosingDoc[]): PeriodTotals {
  let sales = 0;
  let refunds = 0;
  const vat = new Map<string, number>();
  const methods = new Map<string, number>();
  const counts = { SALE: 0, CANCEL: 0, RETURN: 0 };
  for (const d of docs) {
    counts[d.kind]++;
    if (d.kind === 'SALE') sales += d.totalCents;
    else refunds += -d.totalCents;
    for (const v of d.vat) vat.set(v.rate, (vat.get(v.rate) ?? 0) + v.cents);
    for (const p of d.payments) methods.set(p.method, (methods.get(p.method) ?? 0) + p.cents);
  }
  const numbers = docs.map((d) => d.number).sort();
  return {
    tickets: counts.SALE,
    cancellations: counts.CANCEL,
    returns: counts.RETURN,
    salesTotal: centsToDecimal(sales),
    refundsTotal: centsToDecimal(refunds),
    netTotal: centsToDecimal(sales - refunds),
    absoluteTotal: centsToDecimal(sales + refunds),
    byVat: [...vat.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([rate, c]) => ({ rate, ttc: centsToDecimal(c) })),
    byMethod: Object.fromEntries([...methods.entries()].sort().map(([m, c]) => [m, centsToDecimal(c)])),
    firstNumber: numbers[0] ?? null,
    lastNumber: numbers[numbers.length - 1] ?? null,
  };
}

/** The perpetual grand total after a day: it only ever goes up (absolute values). */
export function nextGrandTotal(previous: string, absoluteTotal: string): string {
  const next = decimalToCents(previous) + decimalToCents(absoluteTotal);
  return centsToDecimal(Math.max(next, decimalToCents(previous)));
}

// --- Archive --------------------------------------------------------------------------

export const ARCHIVE_SECTIONS = [
  'sales',
  'saleLines',
  'salePayments',
  'closings',
  'journal',
  'reprints',
] as const;
export type ArchiveSection = (typeof ARCHIVE_SECTIONS)[number];

export interface FiscalArchive {
  version: 1;
  generatedAt: string;
  period: { from: string; to: string };
  sections: Record<ArchiveSection, unknown[]>;
  manifest: {
    counts: Record<ArchiveSection, number>;
    sha256: Record<ArchiveSection, string>;
    /** Hash of the last journal entry of the archive. */
    lastJournalHash: string | null;
  };
  /** HMAC-SHA256 of the manifest, with the server's key. Null when no key was configured. */
  signature: string | null;
}

export async function buildArchive(
  sections: Record<ArchiveSection, unknown[]>,
  meta: { generatedAt: string; from: string; to: string },
  key?: string | null,
): Promise<FiscalArchive> {
  const counts = {} as Record<ArchiveSection, number>;
  const sha256 = {} as Record<ArchiveSection, string>;
  for (const s of ARCHIVE_SECTIONS) {
    counts[s] = sections[s].length;
    sha256[s] = await sha256Hex(canonicalJson(sections[s]));
  }
  const journal = sections.journal as JournalRow[];
  const manifest = { counts, sha256, lastJournalHash: journal.at(-1)?.hash ?? null };
  return {
    version: 1,
    generatedAt: meta.generatedAt,
    period: { from: meta.from, to: meta.to },
    sections,
    manifest,
    signature: key ? await hmacSha256Hex(key, canonicalJson(manifest)) : null,
  };
}

export interface ArchiveVerdict {
  ok: boolean;
  problems: string[];
  /** The signature was checked (a key was given and the archive is signed). */
  signatureChecked: boolean;
}

/** The controller's check: sections match the manifest, the chain holds, the signature is genuine. */
export async function verifyArchive(
  archive: FiscalArchive,
  key?: string | null,
): Promise<ArchiveVerdict> {
  const problems: string[] = [];
  for (const s of ARCHIVE_SECTIONS) {
    const rows = archive.sections?.[s];
    if (!Array.isArray(rows)) {
      problems.push(`section « ${s} » absente`);
      continue;
    }
    if (rows.length !== archive.manifest.counts[s])
      problems.push(`section « ${s} » : ${rows.length} lignes au lieu de ${archive.manifest.counts[s]}`);
    if ((await sha256Hex(canonicalJson(rows))) !== archive.manifest.sha256[s])
      problems.push(`section « ${s} » : le contenu ne correspond plus à son empreinte`);
  }
  const journal = (archive.sections?.journal ?? []) as JournalRow[];
  for (const b of await verifyJournalChain(journal, { key }))
    problems.push(`journal, rang ${b.seq} : ${b.detail}`);
  if ((journal.at(-1)?.hash ?? null) !== archive.manifest.lastJournalHash)
    problems.push('la dernière empreinte du journal ne correspond pas au manifeste');
  let signatureChecked = false;
  if (key) {
    if (!archive.signature) problems.push('archive non signée');
    else {
      signatureChecked = true;
      if ((await hmacSha256Hex(key, canonicalJson(archive.manifest))) !== archive.signature)
        problems.push('signature de l’archive invalide');
    }
  }
  return { ok: problems.length === 0, problems, signatureChecked };
}
