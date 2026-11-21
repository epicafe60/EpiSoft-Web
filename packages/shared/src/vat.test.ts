import { describe, expect, it } from 'vitest';
import {
  allocateExclByRate,
  exclOfInclCents,
  invoiceTotalsDecimal,
  invoiceVatLinesProblem,
  nearestStandardRate,
  normalizeVatRate,
  purchaseVatProblem,
  splitRevenueVat,
  ticketVat,
  EXEMPT_MENTION,
  FRANCHISE_MENTION,
  regimeAt,
  vatRegimeChangeProblem,
  vatBreakdownIncl,
  vatCollectedKey,
  vatOfExclCents,
} from './vat';

describe('R-TVA-01: VAT included in the TTC, by rate', () => {
  it('computes HT from the sum of the rate, never per line', () => {
    // Ten lines of 0.55 € at 5.5 %: per line HT = 0.52 (VAT 0.03) -> HT 5.20 / VAT 0.30; by rate
    // HT = round(5.50 / 1.055) = 5.21, VAT = 0.29.
    const lines = Array.from({ length: 10 }, () => ({ rate: '5.50', inclCents: 55 }));
    const b = vatBreakdownIncl(lines);
    expect(b.byRate).toEqual([{ rate: '5.50', exclCents: 521, vatCents: 29, inclCents: 550 }]);
  });

  it('groups by rate, sorted, and HT + VAT = TTC exactly', () => {
    const b = vatBreakdownIncl([
      { rate: '20.00', inclCents: 1200 },
      { rate: '5.50', inclCents: 211 },
      { rate: '5.5', inclCents: 100 },
      { rate: '0.00', inclCents: 300 },
    ]);
    expect(b.byRate.map((r) => r.rate)).toEqual(['0.00', '5.50', '20.00']);
    expect(b.byRate[0]).toEqual({ rate: '0.00', exclCents: 300, vatCents: 0, inclCents: 300 });
    for (const r of b.byRate) expect(r.exclCents + r.vatCents).toBe(r.inclCents);
    expect(b.exclCents + b.vatCents).toBe(b.inclCents);
    expect(b.inclCents).toBe(1811);
  });

  it('leaves donations out of the breakdown', () => {
    const b = vatBreakdownIncl([
      { rate: '5.50', inclCents: 211 },
      { rate: '0.00', inclCents: 500, outOfScope: true },
    ]);
    expect(b.outOfScopeCents).toBe(500);
    expect(b.inclCents).toBe(211);
  });

  it('is symmetrical for cancellations', () => {
    const sale = vatBreakdownIncl([{ rate: '20.00', inclCents: 1001 }]);
    const cancel = vatBreakdownIncl([{ rate: '20.00', inclCents: -1001 }]);
    expect(cancel.byRate[0]!.vatCents).toBe(-sale.byRate[0]!.vatCents);
    const net = vatBreakdownIncl([
      { rate: '20.00', inclCents: 1001 },
      { rate: '20.00', inclCents: -1001 },
    ]);
    expect(net.byRate[0]).toEqual({ rate: '20.00', exclCents: 0, vatCents: 0, inclCents: 0 });
  });

  it('property: for any amounts, HT + VAT = TTC and VAT is within 1 cent of the exact value', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 500; n++) {
      const rates = ['0.00', '2.10', '5.50', '10.00', '20.00'];
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => ({
        rate: rates[Math.floor(rnd() * 5)]!,
        inclCents: Math.floor(rnd() * 20000) - 2000,
      }));
      const b = vatBreakdownIncl(lines);
      expect(b.exclCents + b.vatCents).toBe(b.inclCents);
      for (const r of b.byRate) {
        const exact = r.inclCents - r.inclCents / (1 + Number(r.rate) / 100);
        expect(Math.abs(r.vatCents - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it('half rounds away from zero', () => {
    expect(exclOfInclCents(105, '5.50')).toBe(100); // 99.526 -> 100
    expect(vatOfExclCents(1000, '5.50')).toBe(55);
    expect(vatOfExclCents(1, '20.00')).toBe(0);
    expect(vatOfExclCents(3, '20.00')).toBe(1); // 0.6
    expect(vatOfExclCents(-3, '20.00')).toBe(-1);
  });
});

describe('R-TVA-02: purchase price of a product', () => {
  const p = (excl4: number | null, vat4: number | null, incl4: number | null, rate = '5.50') =>
    purchaseVatProblem({ excl4, vat4, incl4, rate });
  it('accepts VAT = HT x rate within one cent', () => {
    expect(p(10_000, 550, 10_550)).toBeNull();
    expect(p(10_000, 560, 10_560)).toBeNull(); // 1 cent off
    expect(p(10_000, 0, 10_000, '0.00')).toBeNull();
  });
  it('refuses a VAT that does not match the rate', () => {
    expect(p(10_000, 2_000, 12_000)).toMatch(/taux de 5,5 %/);
    expect(p(10_000, 700, 10_700)).toMatch(/taux/);
    expect(p(10_000, 200, 10_200, '0.00')).toMatch(/taux de 0 %/);
  });
  it('refuses HT + VAT different from TTC, and TTC below HT', () => {
    expect(p(10_000, 550, 10_600)).toMatch(/PA TTC doit être égal/);
    expect(p(10_000, null, 9_000)).toMatch(/inférieur/);
  });
  it('ignores empty fields', () => {
    expect(p(null, null, null)).toBeNull();
    expect(p(10_000, null, null)).toBeNull();
  });
});

describe('R-TVA-03: supplier invoice lines', () => {
  const l = (rate: string, excl: string, vat: string) => ({ rate, excl, vat });
  it('accepts one or several lines and derives the totals', () => {
    const lines = [l('5.50', '100.00', '5.50'), l('20.00', '50.00', '10.00')];
    expect(invoiceVatLinesProblem(lines)).toBeNull();
    expect(invoiceTotalsDecimal(lines)).toEqual({
      totalExcl: '150.00',
      totalVat: '15.50',
      totalIncl: '165.50',
    });
  });
  it('tolerates 2 cents per line, not 3', () => {
    expect(invoiceVatLinesProblem([l('5.50', '100.00', '5.52')])).toBeNull();
    expect(invoiceVatLinesProblem([l('5.50', '100.00', '5.53')])).toMatch(/Ligne 1/);
    expect(invoiceVatLinesProblem([l('5.50', '100.00', '5.47')])).toMatch(/Ligne 1/);
  });
  it('refuses empty, duplicated, unknown rates, bad amounts', () => {
    expect(invoiceVatLinesProblem([])).toMatch(/au moins une ligne/);
    expect(invoiceVatLinesProblem([l('5.5', '10', '0.55'), l('5.50', '10', '0.55')])).toMatch(
      /deux fois/,
    );
    expect(invoiceVatLinesProblem([l('7.00', '10', '0.70')])).toMatch(/non reconnu/);
    expect(invoiceVatLinesProblem([l('20.00', '0', '0')])).toMatch(/HT doit être positif/);
    expect(invoiceVatLinesProblem([l('20.00', '10', '-1')])).toMatch(/négative/);
    expect(invoiceVatLinesProblem([l('20.00', '10', '3')])).toMatch(/doit valoir 2.00/);
  });
  it('a 0 % line carries no VAT', () => {
    expect(invoiceVatLinesProblem([l('0.00', '10', '0')])).toBeNull();
    expect(invoiceVatLinesProblem([l('0.00', '10', '1')])).toMatch(/Ligne 1/);
  });
});

describe('rates and migration helpers', () => {
  it('normalizes standard rates only', () => {
    expect(normalizeVatRate('5,5')).toBe('5.50');
    expect(normalizeVatRate('2.1')).toBe('2.10');
    expect(normalizeVatRate('19.6')).toBeNull();
  });
  it('picks the nearest standard rate for a legacy invoice', () => {
    expect(nearestStandardRate(10_000, 550)).toBe('5.50');
    expect(nearestStandardRate(10_000, 1_564)).toBe('20.00'); // 15.64 % is nearer 20 than 10
    expect(nearestStandardRate(10_000, 0)).toBe('0.00');
    expect(nearestStandardRate(0, 0)).toBe('0.00');
  });
  it('maps rates to collected VAT accounts', () => {
    expect(vatCollectedKey('20.00')).toBe('vatCollected20');
    expect(vatCollectedKey('5.5')).toBe('vatCollected55');
    expect(vatCollectedKey('0.00')).toBeNull();
  });
});

describe('allocation of HT between revenue accounts', () => {
  it('keeps the HT of each rate exact', () => {
    const groups = [
      { key: '707000', rate: '5.50', inclCents: 55 },
      { key: '707100', rate: '5.50', inclCents: 55 },
      { key: '707200', rate: '5.50', inclCents: 55 },
      { key: '707000', rate: '20.00', inclCents: 100 },
    ];
    const out = allocateExclByRate(groups);
    const at55 = out.filter((g) => g.rate === '5.50').reduce((s, g) => s + g.exclCents, 0);
    expect(at55).toBe(exclOfInclCents(165, '5.50'));
    expect(out[3]!.exclCents).toBe(exclOfInclCents(100, '20.00'));
  });
});

describe('R-TVA-04: revenue split of a session, by regime', () => {
  const acct = (r: string) => (r === '20.00' ? '445712' : r === '5.50' ? '445713' : null);
  const base = [
    { account: '707000', rate: '5.50', inclCents: 1055 },
    { account: '707000', rate: '20.00', inclCents: 1200 },
    { account: '707000', rate: '0.00', inclCents: 300 },
    { account: '756000', rate: '0.00', inclCents: 1000 },
    { account: '754000', rate: '0.00', inclCents: 500, outOfScope: true },
  ];
  const total = (r: ReturnType<typeof splitRevenueVat>) =>
    Object.values(r.revenue).reduce((s, c) => s + c, 0) +
    r.vatCollected.reduce((s, v) => s + v.cents, 0);
  it('LIABLE: HT to revenue and VAT per rate, the total stays the TTC', () => {
    const r = splitRevenueVat(base, acct);
    expect(r.vatCollected).toEqual([
      { account: '445713', rate: '5.50', cents: 55 },
      { account: '445712', rate: '20.00', cents: 200 },
    ]);
    expect(r.revenue['707000']).toBe(1000 + 1000 + 300);
    expect(total(r)).toBe(4055);
  });
  it.each(['FRANCHISE', 'EXEMPT'] as const)('%s: TTC on 707, no VAT account', (regime) => {
    const r = splitRevenueVat(
      base.map((g) => ({ ...g, regime })),
      acct,
    );
    expect(r.vatCollected).toEqual([]);
    expect(r.revenue['707000']).toBe(2555);
    expect(total(r)).toBe(4055);
  });
  it('a session mixing regimes (day of the change) splits only the liable tickets', () => {
    const r = splitRevenueVat(
      [
        { account: '707000', rate: '20.00', inclCents: 1200 },
        { account: '707000', rate: '20.00', inclCents: 600, regime: 'FRANCHISE' },
      ],
      acct,
    );
    expect(r.vatCollected).toEqual([{ account: '445712', rate: '20.00', cents: 200 }]);
    expect(r.revenue['707000']).toBe(1000 + 600);
  });
  it('a cancellation net of its sale leaves no VAT line', () => {
    const r = splitRevenueVat(
      [
        { account: '707000', rate: '20.00', inclCents: 1200 },
        { account: '707000', rate: '20.00', inclCents: -1200 },
      ],
      acct,
    );
    expect(r.vatCollected).toEqual([]);
    expect(r.revenue['707000']).toBe(0);
  });
});

describe('R-TVA-05: ticket, by regime', () => {
  const lines = [
    { rate: '5.50', inclCents: 211 },
    { rate: '20.00', inclCents: 120 },
  ];
  it('LIABLE prints one row per rate', () => {
    const t = ticketVat(lines, 'LIABLE');
    expect(t.rows.map((r) => r.rate)).toEqual(['5.50', '20.00']);
    expect(t.mention).toBeNull();
  });
  it('FRANCHISE and EXEMPT print their mention and no rows', () => {
    expect(ticketVat(lines, 'FRANCHISE')).toEqual({ rows: [], mention: FRANCHISE_MENTION });
    expect(FRANCHISE_MENTION).toBe('TVA non applicable, art. 293 B du CGI');
    expect(ticketVat(lines, 'EXEMPT')).toEqual({ rows: [], mention: EXEMPT_MENTION });
  });
});

describe('R-TVA-07: regime in force on a date', () => {
  const changes = [
    { effectiveFrom: '2026-03-01', regime: 'FRANCHISE' as const },
    { effectiveFrom: '2027-01-01', regime: 'LIABLE' as const },
  ];
  it('is LIABLE before any change, then follows the latest change', () => {
    expect(regimeAt([], '2026-01-01')).toBe('LIABLE');
    expect(regimeAt(changes, '2026-02-28')).toBe('LIABLE');
    expect(regimeAt(changes, '2026-03-01')).toBe('FRANCHISE');
    expect(regimeAt(changes, '2026-12-31')).toBe('FRANCHISE');
    expect(regimeAt([...changes].reverse(), '2027-06-01')).toBe('LIABLE');
  });
  it('refuses a change inside a closed year, a duplicate date, a no-op', () => {
    const closed = [{ startDate: '2025-01-01', endDate: '2025-12-31', label: '2025' }];
    const p = (c: { effectiveFrom: string; regime: 'LIABLE' | 'FRANCHISE' | 'EXEMPT' }) =>
      vatRegimeChangeProblem(c, changes, closed);
    expect(p({ effectiveFrom: '2025-06-01', regime: 'EXEMPT' })).toMatch(/exercice clos « 2025 »/);
    expect(p({ effectiveFrom: '2026-03-01', regime: 'EXEMPT' })).toMatch(/existe déjà/);
    expect(p({ effectiveFrom: '2026-06-01', regime: 'FRANCHISE' })).toMatch(/déjà celui/);
    expect(p({ effectiveFrom: '2026-06-01', regime: 'EXEMPT' })).toBeNull();
    expect(p({ effectiveFrom: 'hier', regime: 'EXEMPT' })).toMatch(/invalide/);
  });
});
