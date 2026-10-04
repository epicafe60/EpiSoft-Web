import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNTS,
  accountClass,
  balanceOf,
  buildCarryForwardEntry,
  buildInvoiceEntry,
  buildResultEntry,
  buildSessionEntry,
  buildStockVariationEntry,
  checkEntry,
  yearResultCents,
  type AccountBalance,
  type PlannedLine,
} from './accounting';
import {
  agedPayables,
  ageBucket,
  balanceSheet,
  buildFec,
  incomeStatement,
  situation,
} from './reports';
import { centsToDecimal, parseAmountToCents } from './money';
import {
  closing,
  estimatedBalanceCents,
  lineTotalCents,
  membershipPeriod,
  milliToDecimal,
  parseQtyToMilli,
  percentDiscountCents,
  type PaymentMethod,
} from './pos';
import { inclFromExcl4, orderLineTotals, orderTotals, stockValueCents } from './supplies';

// Randomised invariant checks ("property tests") on the money, cagnotte, stock and accounting
// functions. A seeded generator keeps failures reproducible.

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)]!;
const RUNS = 300;

describe('money and quantities round-trip', () => {
  it('centsToDecimal → parseAmountToCents is the identity', () => {
    const r = rng(1);
    for (let i = 0; i < RUNS; i++) {
      const c = int(r, -10_000_000, 10_000_000);
      expect(parseAmountToCents(centsToDecimal(c))).toBe(c);
    }
  });
  it('milliToDecimal → parseQtyToMilli is the identity', () => {
    const r = rng(2);
    for (let i = 0; i < RUNS; i++) {
      const m = int(r, -9_000_000, 9_000_000);
      expect(parseQtyToMilli(milliToDecimal(m))).toBe(m);
    }
  });
  it('parses comma and dot alike, rounding half up to the cent', () => {
    expect(parseAmountToCents('1,005')).toBe(101);
    expect(parseAmountToCents('1.004')).toBe(100);
    expect(parseAmountToCents('0,994')).toBe(99);
    expect(parseAmountToCents('-0,50')).toBe(-50);
  });
});

describe('till lines', () => {
  it('rounds symmetrically: a cancellation is exactly the opposite of the sale', () => {
    const r = rng(3);
    for (let i = 0; i < RUNS; i++) {
      const qtyMilli = int(r, 1, 20_000);
      const unitPriceCents = int(r, 1, 9_999);
      const discountCents = int(r, 0, 50);
      const sale = lineTotalCents({ qtyMilli, unitPriceCents, discountCents });
      const refund = lineTotalCents({
        qtyMilli: -qtyMilli,
        unitPriceCents,
        discountCents: -discountCents,
      });
      expect(refund).toBe(-sale);
    }
  });
  it('a line total stays within half a cent of the exact product', () => {
    const r = rng(4);
    for (let i = 0; i < RUNS; i++) {
      const qtyMilli = int(r, 1, 20_000);
      const unitPriceCents = int(r, 1, 9_999);
      const exact = (qtyMilli * unitPriceCents) / 1000;
      expect(
        Math.abs(lineTotalCents({ qtyMilli, unitPriceCents, discountCents: 0 }) - exact),
      ).toBeLessThanOrEqual(0.5);
    }
  });
  it('a percentage discount never exceeds the line and is 0 / full at 0 % / 100 %', () => {
    const r = rng(5);
    for (let i = 0; i < RUNS; i++) {
      const l = { qtyMilli: int(r, 1, 20_000), unitPriceCents: int(r, 1, 9_999) };
      const full = lineTotalCents({ ...l, discountCents: 0 });
      const pct = int(r, 0, 100);
      const d = percentDiscountCents(l, pct);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(full);
      expect(percentDiscountCents(l, 0)).toBe(0);
      expect(percentDiscountCents(l, 100)).toBe(full);
    }
  });
});

describe('cagnotte', () => {
  it('the estimated balance is the server balance plus only that household’s pending moves', () => {
    const r = rng(6);
    for (let i = 0; i < RUNS; i++) {
      const server = int(r, -5000, 50_000);
      const pending = Array.from({ length: int(r, 0, 8) }, () => ({
        householdId: pick(r, ['a', 'b']),
        amountCents: int(r, -3000, 3000),
      }));
      const expected =
        server +
        pending.filter((p) => p.householdId === 'a').reduce((s, p) => s + p.amountCents, 0);
      expect(estimatedBalanceCents('a', server, pending)).toBe(expected);
    }
  });
});

describe('cash closing', () => {
  it('difference + expected = counted, and the next float is what stays in the till', () => {
    const r = rng(7);
    for (let i = 0; i < RUNS; i++) {
      const input = {
        openingFloatCents: int(r, 0, 20_000),
        cashSalesCents: int(r, -2000, 100_000),
        cashOtherCents: int(r, 0, 20_000),
        countedCashCents: int(r, 0, 150_000),
        bankDepositCents: int(r, 0, 100_000),
      };
      const c = closing(input);
      expect(c.expectedCashCents + c.differenceCents).toBe(input.countedCashCents);
      expect(c.nextFloatCents + input.bankDepositCents).toBe(input.countedCashCents);
    }
  });
});

describe('memberships', () => {
  it('a renewal starts the day after the end and a period never ends before it starts', () => {
    const r = rng(8);
    for (let i = 0; i < RUNS; i++) {
      const d = `${int(r, 2020, 2030)}-${String(int(r, 1, 12)).padStart(2, '0')}-${String(int(r, 1, 28)).padStart(2, '0')}`;
      const months = int(r, 1, 24);
      const first = membershipPeriod(d, months, null);
      expect(first.end >= first.start).toBe(true);
      const renewal = membershipPeriod(d, months, first.end);
      const next = new Date(`${first.end}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expect(renewal.start).toBe(next.toISOString().slice(0, 10));
    }
  });
  it('month-end starts do not overshoot (31 Jan + 1 month)', () => {
    expect(membershipPeriod('2025-01-31', 1, null).end).toBe('2025-02-27');
    expect(membershipPeriod('2024-02-29', 12, null).end).toBe('2025-02-27');
  });
});

describe('purchase totals and stock value', () => {
  it('TTC = HT + VAT on every line and on the total', () => {
    const r = rng(9);
    for (let i = 0; i < RUNS; i++) {
      const lines = Array.from({ length: int(r, 1, 6) }, () => ({
        qtyMilli: int(r, 1, 50_000),
        unitPriceExcl4: int(r, 1, 999_999),
        vatRate: pick(r, ['0', '2.10', '5.50', '10', '20']),
      }));
      for (const l of lines) {
        const t = orderLineTotals(l);
        expect(t.inclCents).toBe(t.exclCents + t.vatCents);
      }
      const total = orderTotals(lines);
      expect(total.inclCents).toBe(total.exclCents + total.vatCents);
      expect(total.exclCents).toBe(lines.reduce((s, l) => s + orderLineTotals(l).exclCents, 0));
    }
  });
  it('stock value is never negative and grows with the quantity', () => {
    const r = rng(10);
    for (let i = 0; i < RUNS; i++) {
      const price = int(r, 1, 999_999);
      const q = int(r, -5000, 50_000);
      expect(stockValueCents(q, price)).toBeGreaterThanOrEqual(0);
      expect(stockValueCents(q + 1000, price)).toBeGreaterThanOrEqual(stockValueCents(q, price));
    }
    expect(inclFromExcl4(10_000, '20')).toBe(12_000);
  });
});

// --- Accounting ---------------------------------------------------------------------------

const ACCOUNTS = [
  '101000',
  '120000',
  '129000',
  '280000',
  '370000',
  '411000',
  '401001',
  '512001',
  '531000',
  '607000',
  '603700',
  '613000',
  '641000',
  '658000',
  '691000',
  '707000',
  '710000',
  '754000',
  '756000',
  '758000',
  '791000',
];

/** A random ledger: balanced entries over the accounts above. */
function ledger(r: () => number, withOpening: boolean): AccountBalance[] {
  const totals = new Map<string, { d: number; c: number }>();
  const add = (n: string, d: number, c: number) => {
    const t = totals.get(n) ?? { d: 0, c: 0 };
    t.d += d;
    t.c += c;
    totals.set(n, t);
  };
  const entries = int(r, 3, 25);
  for (let e = 0; e < entries; e++) {
    const cents = int(r, 1, 500_000);
    const a = pick(r, ACCOUNTS);
    const b = pick(
      r,
      ACCOUNTS.filter((x) => x !== a),
    );
    add(a, cents, 0);
    add(b, 0, cents);
  }
  if (withOpening) {
    // Legacy opening balance: assets debited against the transitional account 890000.
    const cents = int(r, 1, 900_000);
    add('512001', cents, 0);
    add('890000', 0, cents);
  }
  return [...totals].map(([number, t]) => ({
    number,
    label: number,
    debitCents: t.d,
    creditCents: t.c,
  }));
}

const sum = (xs: readonly PlannedLine[], k: 'debitCents' | 'creditCents') =>
  xs.reduce((s, l) => s + l[k], 0);

describe('accounting statements on random ledgers', () => {
  it('the ledger itself balances (sanity)', () => {
    const r = rng(11);
    for (let i = 0; i < 50; i++)
      expect(ledger(r, true).reduce((s, b) => s + balanceOf(b), 0)).toBe(0);
  });

  it('income statement result = year result (classes 6 and 7, every sub-account)', () => {
    const r = rng(12);
    for (let i = 0; i < RUNS; i++) {
      const l = ledger(r, false);
      expect(incomeStatement(l).resultCents).toBe(yearResultCents(l));
    }
  });

  it('the balance sheet always balances, with or without the opening account', () => {
    const r = rng(13);
    for (let i = 0; i < RUNS; i++) {
      const bs = balanceSheet(ledger(r, i % 2 === 0));
      expect(bs.totalAssetsCents).toBe(bs.totalLiabilitiesCents);
    }
  });

  it('the opening account is shown on its own line and not mixed into the result', () => {
    const l: AccountBalance[] = [
      { number: '512001', label: 'Banque', debitCents: 1000, creditCents: 0 },
      { number: '890000', label: 'Bilan d’ouverture', debitCents: 0, creditCents: 1000 },
    ];
    const bs = balanceSheet(l);
    expect(bs.pendingResultCents).toBe(0);
    expect(bs.liabilities.map((s) => s.code)).toContain('89');
  });

  it('closing entry is balanced, zeroes classes 6 and 7, and the carry-forward is balanced', () => {
    const r = rng(14);
    for (let i = 0; i < RUNS; i++) {
      const l = ledger(r, false);
      const closingLines = buildResultEntry(l, DEFAULT_ACCOUNTS);
      expect(sum(closingLines, 'debitCents')).toBe(sum(closingLines, 'creditCents'));
      // After posting it, every class 6/7 account is at zero.
      const after = new Map(l.map((b) => [b.number, balanceOf(b)]));
      for (const x of closingLines) {
        after.set(x.account, (after.get(x.account) ?? 0) + x.debitCents - x.creditCents);
      }
      for (const [n, v] of after) if (accountClass(n) >= 6) expect(v, n).toBe(0);
      // Carry-forward of the balance sheet accounts is balanced once the result is allocated.
      const post: AccountBalance[] = [...after].map(([number, v]) => ({
        number,
        label: number,
        debitCents: Math.max(v, 0),
        creditCents: Math.max(-v, 0),
      }));
      const cf = buildCarryForwardEntry(post);
      expect(sum(cf, 'debitCents')).toBe(sum(cf, 'creditCents'));
    }
  });

  it('situation intermédiaire result = year result when only 60–68 and 70–78 accounts are used', () => {
    const r = rng(15);
    const OK = [
      '607000',
      '603700',
      '613000',
      '641000',
      '658000',
      '707000',
      '754000',
      '756000',
      '758000',
      '512001',
      '531000',
    ];
    for (let i = 0; i < RUNS; i++) {
      const totals = new Map<string, { d: number; c: number }>();
      for (let e = 0; e < int(r, 2, 15); e++) {
        const cents = int(r, 1, 100_000);
        const a = pick(r, OK);
        const b = pick(
          r,
          OK.filter((x) => x !== a),
        );
        for (const [n, d, c] of [
          [a, cents, 0],
          [b, 0, cents],
        ] as const) {
          const t = totals.get(n) ?? { d: 0, c: 0 };
          t.d += d;
          t.c += c;
          totals.set(n, t);
        }
      }
      const l = [...totals].map(([number, t]) => ({
        number,
        label: number,
        debitCents: t.d,
        creditCents: t.c,
      }));
      expect(situation(l).resultCents).toBe(yearResultCents(l));
    }
  });

  it('automatic entries are balanced: invoice, stock variation', () => {
    const r = rng(16);
    for (let i = 0; i < RUNS; i++) {
      const inv = buildInvoiceEntry({
        supplierAccount: '401001',
        label: 'F',
        expenseLines: Array.from({ length: int(r, 1, 4) }, () => ({
          account: '607000',
          cents: int(r, -5000, 90_000),
        })),
      });
      expect(sum(inv, 'debitCents')).toBe(sum(inv, 'creditCents'));
      const sv = buildStockVariationEntry(int(r, 0, 900_000), int(r, 0, 900_000), DEFAULT_ACCOUNTS);
      expect(sum(sv, 'debitCents')).toBe(sum(sv, 'creditCents'));
    }
  });

  it('a session entry is balanced whenever payments cover the revenue', () => {
    const r = rng(17);
    const METHODS: PaymentMethod[] = ['CASH', 'CHEQUE', 'CARD', 'WALLET', 'TRANSFER'];
    for (let i = 0; i < RUNS; i++) {
      const revenue: Record<string, number> = {
        '707000': int(r, 0, 100_000),
        '756000': int(r, 0, 5000),
        '754000': int(r, 0, 1000),
      };
      let remaining = Object.values(revenue).reduce((s, v) => s + v, 0);
      const payments: Partial<Record<PaymentMethod, number>> = {};
      for (const m of METHODS) {
        const part = m === 'TRANSFER' ? remaining : int(r, 0, remaining);
        payments[m] = part;
        remaining -= part;
      }
      const topups = { CASH: int(r, 0, 5000), CHEQUE: int(r, 0, 5000) };
      const lines = buildSessionEntry(
        { payments, revenue, topups, cashDifferenceCents: int(r, -500, 500) },
        DEFAULT_ACCOUNTS,
      );
      const chk = checkEntry(
        lines.map((l) => ({
          accountId: l.account,
          label: l.label,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
        })),
      );
      expect(
        chk.errors.filter((e) => e.includes('déséquilibrée')),
        JSON.stringify(lines),
      ).toEqual([]);
    }
  });
});

describe('payables ageing and FEC', () => {
  it('every invoice lands in exactly one bucket and the totals add up', () => {
    const r = rng(18);
    for (let i = 0; i < RUNS; i++) {
      const invoices = Array.from({ length: int(r, 1, 12) }, () => ({
        supplierId: pick(r, ['s1', 's2', 's3']),
        supplierName: 'X',
        dueDate: `2026-${String(int(r, 1, 12)).padStart(2, '0')}-${String(int(r, 1, 28)).padStart(2, '0')}`,
        totalCents: int(r, 1, 100_000),
      }));
      const rows = agedPayables(invoices, '2026-06-15');
      const grand = rows.reduce((s, x) => s + x.totalCents, 0);
      expect(grand).toBe(invoices.reduce((s, x) => s + x.totalCents, 0));
      for (const row of rows)
        expect(Object.values(row.buckets).reduce((s, v) => s + v, 0)).toBe(row.totalCents);
    }
    expect(ageBucket('2026-06-15', '2026-06-15')).toBe('NOT_DUE');
    expect(ageBucket('2026-05-16', '2026-06-15')).toBe('D0_30');
  });
  it('FEC amounts use a decimal comma and stay unsigned', () => {
    const fec = buildFec([
      {
        journalCode: 'VTE',
        journalLabel: 'Ventes',
        entryNumber: 'VTE-2026-0001',
        date: '2026-01-02',
        account: '707000',
        accountLabel: 'Ventes',
        pieceRef: null,
        label: 'x',
        debitCents: 0,
        creditCents: 1205,
        lettering: null,
        letteredOn: null,
        validatedOn: '2026-01-03',
      },
    ]);
    expect(fec.split('\r\n')[1]).toContain('\t0,00\t12,05\t');
  });
});
