import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@episoft/db';
import type { ReportColumn, ReportTable } from '../../lib/report-output';

// Detailed analysis behind the integrity checks: one table per family of checks, listing the
// items with the figures needed to understand the gap (what the two sides say, and by how much
// they differ). Read-only; every cell is returned as text, money cells as decimal strings.

interface Analysis {
  title: string;
  /** How to read the table, in plain language. */
  subtitle: string;
  columns: ReportColumn[];
  query: SQL;
}

const text = (key: string, label: string, width = 2): ReportColumn => ({
  key,
  label,
  type: 'text',
  width,
});
const money = (key: string, label: string, width = 1.3): ReportColumn => ({
  key,
  label,
  type: 'money',
  width,
});

const ANALYSES: Record<string, Analysis> = {
  stock: {
    title: 'Stock : produits en écart ou négatifs',
    subtitle:
      'Écart = stock affiché − somme des mouvements. Un écart non nul : le stock affiché est à recalculer (bouton du contrôle STK-01). Un stock négatif sans écart : il manque une entrée (réception ou inventaire), voir « Dernier mouvement ».',
    columns: [
      text('product', 'Produit', 3),
      text('cache', 'Stock affiché', 1.2),
      text('moves', 'Σ mouvements', 1.2),
      text('gap', 'Écart', 1),
      text('receipts', 'Réceptions', 1.1),
      text('sales', 'Ventes', 1.1),
      text('inventories', 'Inventaires', 1.1),
      text('other', 'Pertes, corrections', 1.3),
      text('last', 'Dernier mouvement', 1.4),
    ],
    query: sql`
      select p.code || ' · ' || p.name as product,
             p.stock_qty::text as cache,
             coalesce(sum(m.qty), 0)::text as moves,
             (p.stock_qty - coalesce(sum(m.qty), 0))::text as gap,
             coalesce(sum(m.qty) filter (where m.kind in ('PURCHASE_IN', 'SUPPLIER_RETURN', 'INITIAL')), 0)::text as receipts,
             coalesce(sum(m.qty) filter (where m.kind in ('SALE', 'SALE_CANCEL')), 0)::text as sales,
             coalesce(sum(m.qty) filter (where m.kind = 'INVENTORY'), 0)::text as inventories,
             coalesce(sum(m.qty) filter (where m.kind in ('LOSS', 'CORRECTION')), 0)::text as other,
             coalesce(to_char(max(m.at) at time zone 'Europe/Paris', 'DD/MM/YYYY'), '—') as last
        from app.product p left join app.stock_movement m on m.product_id = p.id
       where p.kind = 'GOODS'
       group by p.id
      having p.stock_qty <> coalesce(sum(m.qty), 0) or p.stock_qty < 0
       order by abs(p.stock_qty - coalesce(sum(m.qty), 0)) desc, p.stock_qty
       limit 500`,
  },

  cagnotte: {
    title: 'Cagnottes : foyers en écart',
    subtitle:
      'Écart tickets = tickets payés par cagnotte − débits enregistrés sur la cagnotte (doit être 0). Écart versements = versements enregistrés − opérations de cagnotte (doit être 0). Les foyers sous le découvert autorisé sont aussi listés. Un écart se corrige sur la fiche du foyer par une correction de cagnotte avec motif.',
    columns: [
      text('foyer', 'Foyer', 1.2),
      text('members', 'Membres', 3),
      money('balance', 'Solde'),
      money('paid', 'Tickets payés en cagnotte'),
      money('debits', 'Débits enregistrés'),
      money('gap_tickets', 'Écart tickets'),
      money('pay_topups', 'Versements enregistrés'),
      money('topups', 'Versements en cagnotte'),
      money('gap_topups', 'Écart versements'),
    ],
    query: sql`
      with w as (
        select household_id,
               sum(amount) as bal,
               sum(amount) filter (where kind = 'TOPUP' and legacy_payid is null) as topups,
               -sum(amount) filter (where kind in ('PURCHASE', 'REFUND')
                   and sale_id in (select id from app.sale where legacy_ref is null)) as debits
          from app.wallet_entry group by 1),
      t as (
        select s.household_id, sum(p.amount) filter (where p.method = 'WALLET') as paid
          from app.sale s join app.sale_payment p on p.sale_id = s.id
         where s.legacy_ref is null group by 1),
      pay as (
        select household_id, sum(amount) as pay_topups from app.member_payment
         where purpose = 'TOPUP' and legacy_payid is null group by 1),
      od as (select coalesce((select (value ->> 'amount')::numeric from app.setting where key = 'wallet.overdraftLimit'), 0) as v)
      select 'Foyer ' || h.number as foyer,
             coalesce((select string_agg(m.last_name || ' ' || m.first_name, ', ' order by m.last_name)
                         from app.member m where m.household_id = h.id), '') as members,
             coalesce(w.bal, 0)::text as balance,
             coalesce(t.paid, 0)::text as paid,
             coalesce(w.debits, 0)::text as debits,
             (coalesce(t.paid, 0) - coalesce(w.debits, 0))::text as gap_tickets,
             coalesce(pay.pay_topups, 0)::text as pay_topups,
             coalesce(w.topups, 0)::text as topups,
             (coalesce(pay.pay_topups, 0) - coalesce(w.topups, 0))::text as gap_topups
        from app.household h
        left join w on w.household_id = h.id
        left join t on t.household_id = h.id
        left join pay on pay.household_id = h.id, od
       where coalesce(t.paid, 0) <> coalesce(w.debits, 0)
          or coalesce(pay.pay_topups, 0) <> coalesce(w.topups, 0)
          or coalesce(w.bal, 0) < -od.v
       order by abs(coalesce(t.paid, 0) - coalesce(w.debits, 0)) desc, coalesce(w.bal, 0)
       limit 500`,
  },

  tickets: {
    title: 'Tickets : totaux, lignes et paiements en écart',
    subtitle:
      'Écart lignes = total − somme des lignes ; écart paiements = total − somme des paiements ; écart remise = remise du ticket − remises des lignes. Les tickets « Ancienne appli » viennent de l’ancienne base et ne se corrigent pas (voir VTE-05). Un ticket de la caisse ne se modifie pas : on l’annule puis on le ressaisit.',
    columns: [
      text('number', 'Ticket', 1.4),
      text('day', 'Date', 1.1),
      text('origin', 'Origine', 1.3),
      text('foyer', 'Foyer', 1),
      money('total', 'Total'),
      money('gap_lines', 'Écart lignes'),
      money('gap_pay', 'Écart paiements'),
      money('gap_disc', 'Écart remise'),
    ],
    query: sql`
      select s.number,
             to_char(s.sold_at at time zone 'Europe/Paris', 'DD/MM/YYYY') as day,
             case when s.legacy_ref is null then 'Caisse' else 'Ancienne appli' end as origin,
             coalesce('Foyer ' || h.number, '—') as foyer,
             s.total::text as total,
             (s.total - coalesce(l.lines, 0))::text as gap_lines,
             (s.total - coalesce(p.paid, 0))::text as gap_pay,
             (s.discount_total - coalesce(l.disc, 0))::text as gap_disc
        from app.sale s
        left join app.household h on h.id = s.household_id
        left join (select sale_id, sum(line_total) as lines, sum(discount) as disc from app.sale_line group by 1) l on l.sale_id = s.id
        left join (select sale_id, sum(amount) as paid from app.sale_payment group by 1) p on p.sale_id = s.id
       where s.total <> coalesce(l.lines, 0)
          or s.total <> coalesce(p.paid, 0)
          or s.discount_total <> coalesce(l.disc, 0)
       order by (s.legacy_ref is not null), greatest(abs(s.total - coalesce(l.lines, 0)), abs(s.total - coalesce(p.paid, 0))) desc
       limit 500`,
  },

  entries: {
    title: 'Écritures déséquilibrées',
    subtitle:
      'Écart = débit − crédit (doit être 0). Un brouillon se corrige directement. Une écriture validée est verrouillée : passez une écriture inverse puis ressaisissez-la.',
    columns: [
      text('journal', 'Journal', 0.9),
      text('number', 'Numéro', 1.4),
      text('day', 'Date', 1.1),
      text('status', 'État', 1),
      text('label', 'Libellé', 3),
      money('debit', 'Débit'),
      money('credit', 'Crédit'),
      money('gap', 'Écart'),
      text('lines', 'Lignes', 0.8),
    ],
    query: sql`
      select j.code as journal,
             coalesce(e.number::text, '(brouillon)') as number,
             to_char(e.date, 'DD/MM/YYYY') as day,
             case e.status when 'VALIDATED' then 'Validée' else 'Brouillon' end as status,
             e.label,
             coalesce(sum(l.debit), 0)::text as debit,
             coalesce(sum(l.credit), 0)::text as credit,
             (coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0))::text as gap,
             count(l.id)::text as lines
        from app.entry e
        join app.journal j on j.id = e.journal_id
        left join app.entry_line l on l.entry_id = e.id
       group by e.id, j.code
      having coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)
          or (e.status = 'VALIDATED' and count(l.id) < 2)
       order by (e.status = 'VALIDATED') desc, e.date desc
       limit 500`,
  },

  invoices: {
    title: 'Factures fournisseur : TTC ≠ HT + TVA',
    subtitle:
      'Écart = TTC − (HT + TVA) (doit être 0). Comparez à la pièce papier et corrigez le montant erroné sur la facture.',
    columns: [
      text('supplier', 'Fournisseur', 2.5),
      text('piece', 'Pièce', 1.4),
      text('day', 'Date', 1.1),
      money('excl', 'HT'),
      money('vat', 'TVA'),
      money('incl', 'TTC'),
      money('gap', 'Écart'),
    ],
    query: sql`
      select s.name as supplier, i.piece_ref as piece, to_char(i.date, 'DD/MM/YYYY') as day,
             i.total_excl::text as excl, i.total_vat::text as vat, i.total_incl::text as incl,
             (i.total_incl - i.total_excl - i.total_vat)::text as gap
        from app.supplier_invoice i join app.supplier s on s.id = i.supplier_id
       where i.total_excl + i.total_vat <> i.total_incl
       order by i.date desc limit 500`,
  },

  preorders: {
    title: 'Précommandes retirées sans ticket',
    subtitle:
      'Ces précommandes sont marquées « retirées » mais ne sont liées à aucun ticket de caisse. Retrouvez le ticket du retrait ; sinon remettez la commande à son état d’origine.',
    columns: [
      text('number', 'Commande', 1.4),
      text('member', 'Adhérent', 2.5),
      text('pickup', 'Retrait prévu', 1.2),
      text('comment', 'Commentaire', 3),
    ],
    query: sql`
      select p.number, m.first_name || ' ' || m.last_name as member,
             to_char(p.pickup_date, 'DD/MM/YYYY') as pickup, coalesce(p.comment, '') as comment
        from app.preorder p join app.member m on m.id = p.member_id
       where p.status = 'PICKED_UP' and p.sale_id is null
       order by p.pickup_date desc limit 500`,
  },
};

/** Which analysis explains which integrity check (CPT-03 has its own edition under Éditions). */
export const ANALYSIS_OF: Record<string, keyof typeof ANALYSES> = {
  'STK-01': 'stock',
  'STK-02': 'stock',
  'STK-03': 'stock',
  'STK-04': 'stock',
  'STK-05': 'stock',
  'CAG-01': 'cagnotte',
  'CAG-02': 'cagnotte',
  'CAG-03': 'cagnotte',
  'VTE-01': 'tickets',
  'VTE-02': 'tickets',
  'VTE-03': 'tickets',
  'VTE-04': 'tickets',
  'VTE-05': 'tickets',
  'CPT-01': 'entries',
  'CPT-02': 'entries',
  'FAC-01': 'invoices',
  'PRE-01': 'preorders',
};

export async function integrityAnalysis(db: Db, checkId: string): Promise<ReportTable | null> {
  const key = ANALYSIS_OF[checkId];
  const a = key ? ANALYSES[key] : undefined;
  if (!a) return null;
  const res = await db.execute(a.query);
  return {
    title: a.title,
    subtitle: a.subtitle,
    columns: a.columns,
    rows: (res.rows as Record<string, string | null>[]).map((r) => ({ cells: r })),
  };
}
