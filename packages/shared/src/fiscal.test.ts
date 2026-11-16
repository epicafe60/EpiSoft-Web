import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SECTIONS,
  buildArchive,
  canonicalJson,
  cashPaymentProblem,
  CASH_PAYMENT_LIMIT_CENTS,
  computePeriodTotals,
  GENESIS_HASH,
  hmacSha256Hex,
  journalHash,
  nextGrandTotal,
  normDecimal,
  registerNumber,
  returnLineRefund,
  sealOp,
  tillSealIsConsistent,
  verifyArchive,
  verifyJournalChain,
  type JournalRow,
  type SealedOp,
} from './fiscal';

const sale = (over: Record<string, unknown> = {}): Extract<SealedOp, { kind: 'SALE' }> => ({
  kind: 'SALE',
  id: '11111111-1111-4111-8111-111111111111',
  deviceSeq: 5,
  payload: {
    sessionId: '22222222-2222-4222-8222-222222222222',
    cashierId: '33333333-3333-4333-8333-333333333333',
    memberId: null,
    soldAt: '2026-11-15T10:00:00.000Z',
    provisionalNumber: 'CAISSE1-000001',
    lines: [
      {
        productId: '44444444-4444-4444-8444-444444444444',
        label: 'Lentilles',
        qty: '2',
        unitPrice: '2.50',
        catalogPrice: '2.50',
        discount: '0',
      },
    ],
    payments: [{ method: 'CASH', amount: '5.00' }],
    total: '5.00',
    emailReceipt: false,
    ...over,
  },
});

describe('canonical form (ADR 0016 §2)', () => {
  it('writes the same bytes whatever the order of the keys', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe(
      canonicalJson({ a: { c: 'x', d: [2, 1] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('drops undefined keys and keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it('writes decimals without useless zeros', () => {
    expect(normDecimal('2.50')).toBe('2.5');
    expect(normDecimal('2.5000')).toBe('2.5');
    expect(normDecimal('-3.00')).toBe('-3');
    expect(normDecimal('0.000')).toBe('0');
    expect(normDecimal('-0.00')).toBe('0');
    expect(normDecimal('007.10')).toBe('7.1');
  });
});

describe('the till seal (offline, §1)', () => {
  it('numbers the ticket after the register counter, not the operation number', () => {
    expect(registerNumber('CAISSE1', 42)).toBe('CAISSE1-000042');
  });

  it('is the same hash on the till and on the server, whatever the spelling of the amounts', async () => {
    const a = await sealOp(sale(), 1, GENESIS_HASH);
    const b = await sealOp(
      sale({ total: '5', payments: [{ method: 'CASH', amount: '5' }] }),
      1,
      GENESIS_HASH,
    );
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when anything the customer sees changes', async () => {
    const base = await sealOp(sale(), 1, GENESIS_HASH);
    const dearer = await sealOp(
      sale({
        lines: [{ ...sale().payload.lines[0]!, unitPrice: '2.60' }],
        total: '5.20',
      }),
      1,
      GENESIS_HASH,
    );
    expect(dearer.hash).not.toBe(base.hash);
    expect((await sealOp(sale(), 2, GENESIS_HASH)).hash).not.toBe(base.hash);
    expect((await sealOp(sale(), 1, 'a'.repeat(64))).hash).not.toBe(base.hash);
  });

  it('verifies a seal and refuses a document changed after it was sealed', async () => {
    const op = sale();
    const seal = await sealOp(op, 1, GENESIS_HASH);
    expect(await tillSealIsConsistent(op, seal)).toBe(true);
    const tampered = sale({ total: '0.50' });
    expect(await tillSealIsConsistent(tampered, seal)).toBe(false);
    // The number printed must be the one the seal counts.
    expect(await tillSealIsConsistent(sale({ provisionalNumber: 'CAISSE1-000009' }), seal)).toBe(
      false,
    );
  });

  it('chains the documents of a register: each one covers the previous hash', async () => {
    const first = await sealOp(sale(), 1, GENESIS_HASH);
    const second = await sealOp(sale({ provisionalNumber: 'CAISSE1-000002' }), 2, first.hash);
    expect(second.prev).toBe(first.hash);
    expect(
      await tillSealIsConsistent(sale({ provisionalNumber: 'CAISSE1-000002' }), {
        ...second,
        prev: GENESIS_HASH,
      }),
    ).toBe(false);
  });
});

async function chain(n: number, key?: string): Promise<JournalRow[]> {
  const rows: JournalRow[] = [];
  let prevHash = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const r = {
      seq,
      at: `2026-11-15T10:0${seq}:00.000Z`,
      kind: 'SALE',
      data: { n: seq },
      prevHash,
    };
    const hash = await journalHash(r);
    rows.push({ ...r, hash, signature: key ? await hmacSha256Hex(key, hash) : null });
    prevHash = hash;
  }
  return rows;
}

describe('the server journal chain (§2)', () => {
  const key = 'k'.repeat(32);

  it('accepts an intact chain, signed or not', async () => {
    expect(await verifyJournalChain(await chain(4), { startPrev: GENESIS_HASH })).toEqual([]);
    expect(await verifyJournalChain(await chain(4, key), { key, startPrev: GENESIS_HASH })).toEqual(
      [],
    );
  });

  it('finds a changed entry', async () => {
    const rows = await chain(4, key);
    rows[1] = { ...rows[1]!, data: { n: 99 } };
    const breaks = await verifyJournalChain(rows, { key });
    expect(breaks.map((b) => [b.seq, b.problem])).toContainEqual([2, 'HASH']);
  });

  it('finds a deleted entry', async () => {
    const rows = await chain(5, key);
    rows.splice(2, 1);
    const breaks = await verifyJournalChain(rows, { key });
    expect(breaks.map((b) => b.problem)).toEqual(expect.arrayContaining(['GAP', 'LINK']));
  });

  it('finds a chain recomputed by someone who has no key', async () => {
    const rows = await chain(3, 'x'.repeat(32));
    const breaks = await verifyJournalChain(rows, { key });
    expect(breaks.every((b) => b.problem === 'SIGNATURE')).toBe(true);
    expect(breaks).toHaveLength(3);
    const unsigned = await verifyJournalChain(await chain(2), { key });
    expect(unsigned.map((b) => b.problem)).toEqual(['UNSIGNED', 'UNSIGNED']);
  });

  it('finds a first entry that does not follow the origin', async () => {
    const rows = await chain(2);
    const breaks = await verifyJournalChain(rows.slice(1), { startPrev: GENESIS_HASH });
    expect(breaks.map((b) => b.problem)).toContain('LINK');
  });
});

describe('cash payment ceiling (§6, art. D112-3 CMF)', () => {
  it('accepts up to 1 000 € and refuses above', () => {
    expect(cashPaymentProblem(CASH_PAYMENT_LIMIT_CENTS)).toBeNull();
    expect(cashPaymentProblem(CASH_PAYMENT_LIMIT_CENTS + 1)).toMatch(/1000.00 €.*D112-3/);
  });
  it('has a higher ceiling for a non-resident', () => {
    expect(cashPaymentProblem(500_000, { resident: false })).toBeNull();
    expect(cashPaymentProblem(1_500_001, { resident: false })).not.toBeNull();
  });
});

describe('credit note amounts (§5)', () => {
  const line = { lineTotalCents: 1000, qtyMilli: 3000, returnedQtyMilli: 0, returnedCents: 0 };
  it('takes the price pro rata', () => {
    expect(returnLineRefund({ ...line, returnQtyMilli: 1000 })).toEqual({ cents: 333 });
  });
  it('gives the rest on the last fraction, so the sum is exactly what was sold', () => {
    const a = returnLineRefund({ ...line, returnQtyMilli: 1000 }) as { cents: number };
    const b = returnLineRefund({
      ...line,
      returnedQtyMilli: 1000,
      returnedCents: a.cents,
      returnQtyMilli: 1000,
    }) as { cents: number };
    const c = returnLineRefund({
      ...line,
      returnedQtyMilli: 2000,
      returnedCents: a.cents + b.cents,
      returnQtyMilli: 1000,
    }) as { cents: number };
    expect(a.cents + b.cents + c.cents).toBe(1000);
  });
  it('refuses more than what is left', () => {
    expect(returnLineRefund({ ...line, returnedQtyMilli: 2500, returnQtyMilli: 1000 })).toEqual({
      error: expect.stringContaining('il reste 0.5'),
    });
    expect(returnLineRefund({ ...line, returnQtyMilli: 0 })).toHaveProperty('error');
  });
});

describe('period totals and the perpetual grand total (§3)', () => {
  const docs = [
    {
      number: 'T-2026-000001',
      kind: 'SALE' as const,
      totalCents: 1050,
      vat: [
        { rate: '5.5', cents: 550 },
        { rate: '20', cents: 500 },
      ],
      payments: [{ method: 'CASH', cents: 1050 }],
    },
    {
      number: 'T-2026-000002',
      kind: 'SALE' as const,
      totalCents: 200,
      vat: [{ rate: '5.5', cents: 200 }],
      payments: [{ method: 'CARD', cents: 200 }],
    },
    {
      number: 'T-2026-000003',
      kind: 'CANCEL' as const,
      totalCents: -200,
      vat: [{ rate: '5.5', cents: -200 }],
      payments: [{ method: 'CARD', cents: -200 }],
    },
    {
      number: 'T-2026-000004',
      kind: 'RETURN' as const,
      totalCents: -100,
      vat: [{ rate: '20', cents: -100 }],
      payments: [{ method: 'CASH', cents: -100 }],
    },
  ];

  it('counts documents, by VAT rate and by payment method', () => {
    const t = computePeriodTotals(docs);
    expect([t.tickets, t.cancellations, t.returns]).toEqual([2, 1, 1]);
    expect(t.salesTotal).toBe('12.50');
    expect(t.refundsTotal).toBe('3.00');
    expect(t.netTotal).toBe('9.50');
    expect(t.absoluteTotal).toBe('15.50');
    expect(t.byVat).toEqual([
      { rate: '5.5', ttc: '5.50' },
      { rate: '20', ttc: '4.00' },
    ]);
    expect(t.byMethod).toEqual({ CARD: '0.00', CASH: '9.50' });
    expect([t.firstNumber, t.lastNumber]).toEqual(['T-2026-000001', 'T-2026-000004']);
  });

  it('never lets the grand total go down, cancellations and returns included', () => {
    const t = computePeriodTotals(docs);
    expect(nextGrandTotal('100.00', t.absoluteTotal)).toBe('115.50');
    expect(nextGrandTotal('100.00', '0.00')).toBe('100.00');
  });
});

describe('the archive (§8)', () => {
  const key = 'a'.repeat(32);
  async function archive() {
    const sections = Object.fromEntries(
      ARCHIVE_SECTIONS.map((s) => [s, [] as unknown[]]),
    ) as Record<(typeof ARCHIVE_SECTIONS)[number], unknown[]>;
    sections.sales = [{ id: 's1', total: '5' }];
    sections.journal = await chain(3, key);
    return buildArchive(
      sections,
      { generatedAt: '2026-11-16T00:00:00.000Z', from: '2026-11-15', to: '2026-11-15' },
      key,
    );
  }

  it('verifies as produced, with and without the key', async () => {
    const a = await archive();
    expect(await verifyArchive(a, key)).toEqual({ ok: true, problems: [], signatureChecked: true });
    expect((await verifyArchive(a)).ok).toBe(true);
  });

  it('finds a changed amount, a deleted entry and a forged manifest', async () => {
    const a = await archive();
    const edited = structuredClone(a);
    (edited.sections.sales[0] as { total: string }).total = '0.01';
    expect((await verifyArchive(edited, key)).problems.join(' ')).toMatch(/sales/);

    const cut = structuredClone(a);
    cut.sections.journal.pop();
    expect((await verifyArchive(cut, key)).ok).toBe(false);

    const forged = structuredClone(edited);
    forged.manifest.sha256.sales = (
      await buildArchive(
        { ...edited.sections },
        { generatedAt: edited.generatedAt, from: '', to: '' },
      )
    ).manifest.sha256.sales;
    const v = await verifyArchive(forged, key);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/signature de l’archive invalide/);
  });
});
