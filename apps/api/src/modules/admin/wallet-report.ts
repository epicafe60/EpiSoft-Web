import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '@episoft/db';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { reportXlsx, type ReportTable } from '../../lib/report-output';

/** One line per household: the balance and where it comes from (R-EVO-50). */
interface WalletRow {
  number: number;
  referent: string | null;
  balance: string;
  topups: string;
  purchases: string;
  refunds: string;
  corrections: string;
  entries: number;
  lastAt: string | null;
  walletPaid: string;
  booked: string;
  gap: string;
  status: 'OK' | 'NEGATIVE' | 'CHECK';
}

const STATUS_LABELS = {
  OK: 'Vert',
  NEGATIVE: 'Rouge (solde négatif)',
  CHECK: 'À vérifier',
} as const;

/**
 * R-EVO-50: for every household, the cagnotte rebuilt from its history (top-ups, purchases,
 * refunds, corrections) next to what the tickets say was paid from it. A household is green when
 * both agree and the balance is not negative; the figures given by the "cagnottes folles" survey
 * are compared with the balance column. Read-only.
 */
export async function walletReport(db: Db): Promise<WalletRow[]> {
  const res = await db.execute<Omit<WalletRow, 'status'>>(sql`
    with e as (
      select household_id,
             coalesce(sum(amount) filter (where kind = 'TOPUP'), 0) as topups,
             coalesce(sum(amount) filter (where kind = 'PURCHASE'), 0) as purchases,
             coalesce(sum(amount) filter (where kind = 'REFUND'), 0) as refunds,
             coalesce(sum(amount) filter (where kind = 'CORRECTION'), 0) as corrections,
             count(*)::int as entries,
             max(at) as last_at,
             coalesce(sum(amount) filter (where kind in ('PURCHASE', 'REFUND') and sale_id is not null), 0) as booked
      from app.wallet_entry group by household_id),
    s as (
      select sa.household_id, coalesce(sum(p.amount), 0) as wallet_paid
      from app.sale sa join app.sale_payment p on p.sale_id = sa.id and p.method = 'WALLET'
      where sa.legacy_ref is null and sa.household_id is not null group by sa.household_id)
    select h.number,
           (select m.last_name || ' ' || m.first_name from app.member m where m.id = h.referent_member_id) as referent,
           coalesce(b.balance, 0)::text as balance,
           coalesce(e.topups, 0)::text as topups,
           coalesce(e.purchases, 0)::text as purchases,
           coalesce(e.refunds, 0)::text as refunds,
           coalesce(e.corrections, 0)::text as corrections,
           coalesce(e.entries, 0) as entries,
           e.last_at::text as "lastAt",
           coalesce(s.wallet_paid, 0)::text as "walletPaid",
           coalesce(e.booked, 0)::text as booked,
           (coalesce(s.wallet_paid, 0) + coalesce(e.booked, 0))::text as gap
    from app.household h
      left join app.household_balance b on b.household_id = h.id
      left join e on e.household_id = h.id
      left join s on s.household_id = h.id
    order by h.number`);
  return res.rows.map((r) => ({
    ...r,
    status:
      Number(r.balance) < 0
        ? 'NEGATIVE'
        : Number(r.gap) !== 0
          ? 'CHECK'
          : ('OK' as WalletRow['status']),
  }));
}

function asTable(rows: WalletRow[]): ReportTable {
  const money = (k: keyof WalletRow, label: string) => ({ key: k, label, type: 'money' as const });
  return {
    title: 'Cagnottes par foyer',
    subtitle: 'Solde, historique reconstitué et écart avec les tickets',
    columns: [
      { key: 'number', label: 'Foyer', type: 'text' },
      { key: 'referent', label: 'Référent', type: 'text', width: 2 },
      money('balance', 'Solde'),
      money('topups', 'Versements'),
      money('purchases', 'Achats'),
      money('refunds', 'Remboursements'),
      money('corrections', 'Corrections'),
      money('walletPaid', 'Payé en cagnotte (tickets)'),
      money('booked', 'Écritures des tickets'),
      money('gap', 'Écart'),
      { key: 'lastAt', label: 'Dernier mouvement', type: 'text' },
      { key: 'status', label: 'État', type: 'text', width: 2 },
    ],
    rows: rows.map((r) => ({
      cells: {
        number: String(r.number),
        referent: r.referent,
        balance: r.balance,
        topups: r.topups,
        purchases: r.purchases,
        refunds: r.refunds,
        corrections: r.corrections,
        walletPaid: r.walletPaid,
        booked: r.booked,
        gap: r.gap,
        lastAt: r.lastAt,
        status: STATUS_LABELS[r.status],
      },
      link: null,
    })),
  };
}

export const walletReportRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const guard = { preHandler: app.requireRoles('ADMIN', 'COMPTA', 'ADHERENTS') };

  app.get('/admin/wallet-report', guard, async () => {
    const rows = await walletReport(db);
    return {
      households: rows.length,
      green: rows.filter((r) => r.status === 'OK').length,
      negative: rows.filter((r) => r.status === 'NEGATIVE').length,
      toCheck: rows.filter((r) => r.status === 'CHECK').length,
      rows,
    };
  });

  app.get(
    '/admin/wallet-report.xlsx',
    { ...guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const rows = await walletReport(db);
      const buf = await reportXlsx(asTable(rows));
      // Names and balances of every household: who took them is kept.
      await audit(db, req, {
        action: 'wallet.report_export',
        entity: 'household',
        after: { rows: rows.length },
      });
      return reply
        .header('content-disposition', 'attachment; filename="cagnottes-par-foyer.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buf);
    },
  );
};
