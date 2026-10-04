import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { integrityAck, type Db } from '@episoft/db';
import type { Config } from '../../config';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/problem';
import { FALLBACK_HELP, INTEGRITY_HELP, type IntegrityHelp } from './integrity-help';
import { ANALYSIS_OF, integrityAnalysis } from './integrity-analysis';
import { reportXlsx } from '../../lib/report-output';

type Row = Record<string, unknown>;

export interface IntegrityCheck {
  id: string;
  label: string;
  /** error: a calculation is wrong; warning: needs a human look (legacy data, drafts…). */
  severity: 'error' | 'warning';
  /** Returns one row per violation, with a readable `ref` and `detail`. */
  query: SQL;
}

/**
 * Automated cross-checks of the computed figures (stock, cagnotte, sales, accounting). Every
 * check is read-only and returns the offending rows; an empty result is a pass. Legacy rows
 * (migrated, with a legacy_* key) are left out of the checks that need data the old
 * application never kept.
 */
export const INTEGRITY_CHECKS: IntegrityCheck[] = [
  {
    id: 'STK-01',
    label: 'Le stock en cache de chaque produit égale la somme de ses mouvements',
    severity: 'error',
    query: sql`
      select p.code as ref,
             'stock ' || p.stock_qty || ' ≠ mouvements ' || coalesce(sum(m.qty), 0) as detail,
             '/catalogue/' || p.id as link
      from app.product p left join app.stock_movement m on m.product_id = p.id
      group by p.id, p.code, p.stock_qty
      having p.stock_qty <> coalesce(sum(m.qty), 0)`,
  },
  {
    id: 'STK-02',
    label: 'Chaque ticket de caisse a décrémenté le stock de ses articles, une seule fois',
    severity: 'error',
    query: sql`
      with expected as (
        select s.id as sale_id, s.number, l.product_id, sum(l.qty) as q
        from app.sale_line l
          join app.sale s on s.id = l.sale_id and s.legacy_ref is null
          join app.product p on p.id = l.product_id and p.kind = 'GOODS'
        group by s.id, s.number, l.product_id),
      actual as (
        select m.source_id, m.product_id, sum(m.qty) as q
        from app.stock_movement m
        where m.source_type = 'sale' group by m.source_id, m.product_id)
      select e.number as ref, 'quantité vendue ' || e.q || ' / mouvement ' || coalesce(a.q, 0) as detail,
             '/catalogue/' || e.product_id as link
      from expected e left join actual a on a.source_id = e.sale_id::text and a.product_id = e.product_id
      where e.q <> -coalesce(a.q, 0)`,
  },
  {
    id: 'STK-03',
    label: 'Chaque réception de marchandises correspond à des entrées de stock identiques',
    severity: 'error',
    query: sql`
      with expected as (
        select r.id as receipt_id, r.number, l.product_id, sum(l.qty) as q
        from app.goods_receipt_line l
          join app.goods_receipt r on r.id = l.receipt_id and r.legacy_fnrcomid is null
          join app.product p on p.id = l.product_id and p.kind = 'GOODS'
        group by r.id, r.number, l.product_id),
      actual as (
        select m.source_id, m.product_id, sum(m.qty) as q
        from app.stock_movement m where m.source_type = 'receipt' group by m.source_id, m.product_id)
      select e.number as ref, 'reçu ' || e.q || ' / mouvement ' || coalesce(a.q, 0) as detail,
             '/catalogue/' || e.product_id as link
      from expected e left join actual a on a.source_id = e.receipt_id::text and a.product_id = e.product_id
      where e.q <> coalesce(a.q, 0)`,
  },
  {
    id: 'STK-04',
    label: 'Chaque ajustement d’inventaire validé correspond à un mouvement identique',
    severity: 'error',
    query: sql`
      select s.label as ref, 'ajustement ' || l.adjustment || ' / mouvement ' || coalesce(sum(m.qty), 0) as detail,
             '/appros/inventaires/' || s.id as link
      from app.inventory_line l
        join app.inventory_session s on s.id = l.session_id
        left join app.stock_movement m
          on m.source_type = 'inventory' and m.source_id = s.id::text and m.product_id = l.product_id
      where l.adjustment is not null
      group by s.id, s.label, l.product_id, l.adjustment
      having l.adjustment <> coalesce(sum(m.qty), 0)`,
  },
  {
    id: 'STK-05',
    label: 'Aucun produit n’a un stock négatif (ventes sans réception ou inventaire en retard)',
    severity: 'warning',
    query: sql`
      select p.code as ref, p.name || ' : stock ' || p.stock_qty as detail,
             '/catalogue/' || p.id as link
      from app.product p where p.stock_qty < 0 and p.kind = 'GOODS' order by p.stock_qty`,
  },
  {
    id: 'CAG-01',
    label:
      'Les paiements en cagnotte d’un ticket correspondent exactement aux écritures de la cagnotte',
    severity: 'error',
    query: sql`
      with paid as (
        select s.id, s.number, s.household_id,
               coalesce(sum(p.amount) filter (where p.method = 'WALLET'), 0) as wallet_paid
        from app.sale s left join app.sale_payment p on p.sale_id = s.id
        where s.legacy_ref is null group by s.id, s.number, s.household_id),
      booked as (
        select w.sale_id, coalesce(sum(w.amount) filter (where w.kind in ('PURCHASE', 'REFUND')), 0) as moved
        from app.wallet_entry w where w.sale_id is not null group by w.sale_id)
      select paid.number as ref, 'payé en cagnotte ' || paid.wallet_paid || ' / écritures ' || coalesce(booked.moved, 0) as detail,
             '/foyers/' || paid.household_id as link
      from paid left join booked on booked.sale_id = paid.id
      where paid.wallet_paid <> -coalesce(booked.moved, 0)`,
  },
  {
    id: 'CAG-02',
    label: 'Chaque versement de cagnotte a une écriture de même montant, et inversement',
    severity: 'error',
    query: sql`
      select 'versement ' || mp.id as ref, 'montant ' || mp.amount || ' / cagnotte ' || coalesce(sum(w.amount), 0) as detail,
             '/foyers/' || mp.household_id as link
      from app.member_payment mp left join app.wallet_entry w on w.payment_id = mp.id
      where mp.purpose = 'TOPUP' and mp.legacy_payid is null
      group by mp.id, mp.amount, mp.household_id
      having mp.amount <> coalesce(sum(w.amount), 0)
      union all
      select 'écriture ' || w.id, 'écriture sans versement', '/foyers/' || w.household_id from app.wallet_entry w
      where w.kind = 'TOPUP' and w.payment_id is null and w.legacy_payid is null`,
  },
  {
    id: 'CAG-03',
    label: 'Aucun foyer ne dépasse le découvert autorisé sans forçage enregistré',
    severity: 'warning',
    query: sql`
      select 'foyer ' || h.number as ref, 'solde ' || b.balance as detail,
             '/foyers/' || h.id as link
      from app.household_balance b join app.household h on h.id = b.household_id
      where b.balance < -coalesce(
        (select (value ->> 'amount')::numeric from app.setting where key = 'wallet.overdraftLimit'), 0)
        and not exists (select 1 from app.wallet_entry w where w.household_id = h.id and w.forced_by is not null)`,
  },
  {
    id: 'VTE-01',
    label: 'Le total d’un ticket égale la somme de ses lignes, et chaque ligne est bien calculée',
    severity: 'error',
    query: sql`
      select s.number as ref, 'total ' || s.total || ' / lignes ' || coalesce(sum(l.line_total), 0) as detail,
             '/foyers/' || s.household_id as link
      from app.sale s left join app.sale_line l on l.sale_id = s.id
      where s.legacy_ref is null group by s.id, s.number, s.total, s.household_id
      having s.total <> coalesce(sum(l.line_total), 0)
      union all
      select s.number, 'ligne ' || l.line_no || ' : ' || l.line_total || ' ≠ ' || round(l.qty * l.unit_price - l.discount, 2),
             '/foyers/' || s.household_id
      from app.sale_line l join app.sale s on s.id = l.sale_id
      where s.legacy_ref is null and l.line_total <> round(l.qty * l.unit_price - l.discount, 2)`,
  },
  {
    id: 'VTE-02',
    label: 'Les paiements d’un ticket totalisent exactement son montant',
    severity: 'error',
    query: sql`
      select s.number as ref, 'total ' || s.total || ' / paiements ' || coalesce(sum(p.amount), 0) as detail,
             '/foyers/' || s.household_id as link
      from app.sale s left join app.sale_payment p on p.sale_id = s.id
      where s.legacy_ref is null group by s.id, s.number, s.total, s.household_id
      having s.total <> coalesce(sum(p.amount), 0)`,
  },
  {
    id: 'VTE-03',
    label: 'Une annulation est exactement l’opposé du ticket annulé, et celui-ci est marqué annulé',
    severity: 'error',
    query: sql`
      select c.number as ref, 'annulation ' || c.total || ' / ticket ' || o.total as detail,
             '/foyers/' || c.household_id as link
      from app.sale c join app.sale o on o.id = c.cancels_sale_id
      where c.total <> -o.total or o.status <> 'CANCELLED'`,
  },
  {
    id: 'VTE-05',
    label:
      'Tickets migrés dont le total diffère de la somme des lignes (données de l’ancienne application)',
    severity: 'warning',
    query: sql`
      select s.number as ref, 'total ' || s.total || ' / lignes ' || coalesce(sum(l.line_total), 0) as detail,
             '/foyers/' || s.household_id as link
      from app.sale s left join app.sale_line l on l.sale_id = s.id
      where s.legacy_ref is not null group by s.id, s.number, s.total, s.household_id
      having s.total <> coalesce(sum(l.line_total), 0)`,
  },
  {
    id: 'VTE-04',
    label: 'La remise totale d’un ticket égale la somme des remises de ses lignes',
    severity: 'warning',
    query: sql`
      select s.number as ref, 'remise ' || s.discount_total || ' / lignes ' || coalesce(sum(l.discount), 0) as detail,
             '/foyers/' || s.household_id as link
      from app.sale s left join app.sale_line l on l.sale_id = s.id
      where s.legacy_ref is null group by s.id, s.number, s.discount_total, s.household_id
      having s.discount_total <> coalesce(sum(l.discount), 0)`,
  },
  {
    id: 'CPT-01',
    label: 'Toute écriture validée est équilibrée et compte au moins deux lignes',
    severity: 'error',
    query: sql`
      select coalesce(e.number::text, e.id::text) as ref,
             'débit ' || coalesce(sum(l.debit), 0) || ' / crédit ' || coalesce(sum(l.credit), 0) || ' (' || count(l.id) || ' lignes)' as detail,
             '/compta/ecritures/' || e.id as link
      from app.entry e left join app.entry_line l on l.entry_id = e.id
      where e.status = 'VALIDATED' group by e.id, e.number
      having coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0) or count(l.id) < 2`,
  },
  {
    id: 'CPT-02',
    label: 'Les brouillons d’écriture déséquilibrés sont à corriger avant validation',
    severity: 'warning',
    query: sql`
      select e.id::text as ref,
             'débit ' || coalesce(sum(l.debit), 0) || ' / crédit ' || coalesce(sum(l.credit), 0) as detail,
             '/compta/ecritures/' || e.id as link
      from app.entry e left join app.entry_line l on l.entry_id = e.id
      where e.status = 'DRAFT' group by e.id
      having coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)`,
  },
  {
    id: 'CPT-03',
    label: 'Le compte 411000 (dette envers les adhérents) égale le total des cagnottes',
    severity: 'warning',
    query: sql`
      with acc as (
        select coalesce(sum(l.credit - l.debit) filter (where e.status = 'VALIDATED'), 0) as v,
               coalesce(sum(l.credit - l.debit), 0) as v_all
        from app.entry_line l join app.account a on a.id = l.account_id
        join app.entry e on e.id = l.entry_id
        where a.number = '411000'),
      wallet as (select coalesce(sum(balance), 0) as v from app.household_balance)
      select '411000' as ref,
             'écritures validées ' || acc.v || ' (brouillons compris : ' || acc.v_all || ') / cagnottes ' || wallet.v
               || ' → écart ' || (acc.v - wallet.v) || ' (brouillons compris : ' || (acc.v_all - wallet.v) || ')' as detail,
             '/compta/editions?edition=wallet-411' as link
      from acc, wallet where acc.v <> wallet.v`,
  },
  {
    id: 'FAC-01',
    label: 'Une facture fournisseur : TTC = HT + TVA',
    severity: 'error',
    query: sql`
      select i.id::text as ref, 'HT ' || i.total_excl || ' + TVA ' || i.total_vat || ' ≠ TTC ' || i.total_incl as detail,
             '/appros/factures/' || i.id as link
      from app.supplier_invoice i where i.total_excl + i.total_vat <> i.total_incl`,
  },
  {
    id: 'PRE-01',
    label: 'Une précommande retirée est liée à son ticket de caisse',
    severity: 'warning',
    query: sql`
      select p.number as ref, 'retirée sans ticket' as detail, '/precommandes' as link
      from app.preorder p where p.status = 'PICKED_UP' and p.sale_id is null`,
  },
];

/** Where to review all the items of a check. */
const LISTS: Record<string, { to: string; label: string }> = {
  'STK-01': { to: '/catalogue', label: 'Catalogue' },
  'STK-02': { to: '/appros/stock', label: 'Stock' },
  'STK-03': { to: '/appros/commandes', label: 'Commandes' },
  'STK-04': { to: '/appros/inventaires', label: 'Inventaires' },
  'STK-05': { to: '/appros/stock', label: 'Stock' },
  'CAG-01': { to: '/membres', label: 'Membres' },
  'CAG-02': { to: '/membres', label: 'Membres' },
  'CAG-03': { to: '/membres', label: 'Membres' },
  'CPT-01': { to: '/compta/ecritures', label: 'Écritures' },
  'CPT-02': { to: '/compta/ecritures', label: 'Écritures' },
  'CPT-03': {
    to: '/compta/editions?edition=wallet-411',
    label: 'Rapprochement cagnottes / 411000',
  },
  'FAC-01': { to: '/appros/factures', label: 'Factures' },
  'PRE-01': { to: '/precommandes', label: 'Précommandes' },
};

/**
 * One-click remediations, only for figures that are derived from a source of truth: they
 * recompute the derived value, never invent data. Each returns the number of rows changed.
 */
const FIXES: Record<string, { label: string; confirm: string; run: (db: Db) => Promise<number> }> =
  {
    'STK-01': {
      label: 'Recalculer le stock depuis les mouvements',
      confirm:
        'Le stock en cache des produits en écart sera remplacé par la somme de leurs mouvements (le journal des mouvements fait foi). Continuer ?',
      run: async (db) =>
        (
          await db.execute(sql`
          update app.product p
             set stock_qty = (select coalesce(sum(m.qty), 0) from app.stock_movement m where m.product_id = p.id),
                 updated_at = p.updated_at
           where p.stock_qty <> (select coalesce(sum(m.qty), 0) from app.stock_movement m where m.product_id = p.id)`)
        ).rowCount ?? 0,
    },
    'VTE-04': {
      label: 'Recalculer la remise totale des tickets',
      confirm:
        'La remise totale de chaque ticket en écart sera remplacée par la somme des remises de ses lignes. Continuer ?',
      run: async (db) =>
        (
          await db.execute(sql`
          update app.sale s
             set discount_total = (select coalesce(sum(l.discount), 0) from app.sale_line l where l.sale_id = s.id)
           where s.legacy_ref is null
             and s.discount_total <> (select coalesce(sum(l.discount), 0) from app.sale_line l where l.sale_id = s.id)`)
        ).rowCount ?? 0,
    },
  };

export interface IntegritySample {
  ref: string;
  detail: string;
  /** App page of the item, when there is one. */
  link: string | null;
}

export interface IntegrityResult {
  id: string;
  label: string;
  severity: 'error' | 'warning';
  /** Open cases (accepted warnings are not counted). */
  count: number;
  samples: IntegritySample[];
  list: { to: string; label: string } | null;
  fix: { label: string; confirm: string } | null;
  /** What is compared and what to do when cases are listed. */
  help: IntegrityHelp;
  /** A detailed table (figures on both sides, gaps) is available for this check. */
  analysis: boolean;
  /** Warnings can be accepted after review; errors cannot. */
  ackable: boolean;
  accepted: (IntegritySample & { note: string | null })[];
}

export interface IntegrityReport {
  at: string;
  errors: number;
  warnings: number;
  checks: IntegrityResult[];
}

const SAMPLES = 10;

/** Runs every check; a failing query is reported as an error, never thrown. */
export async function runIntegrityChecks(db: Db): Promise<IntegrityReport> {
  const checks: IntegrityResult[] = [];
  const acks = await db.select().from(integrityAck);
  const ackOf = new Map(acks.map((a) => [`${a.checkId}|${a.ref}`, a.note]));
  for (const c of INTEGRITY_CHECKS) {
    const common = {
      id: c.id,
      label: c.label,
      help: INTEGRITY_HELP[c.id] ?? FALLBACK_HELP,
      analysis: c.id in ANALYSIS_OF,
      list: LISTS[c.id] ?? null,
      fix: FIXES[c.id] ? { label: FIXES[c.id]!.label, confirm: FIXES[c.id]!.confirm } : null,
      ackable: c.severity === 'warning',
    };
    try {
      const res = await db.execute(c.query);
      const rows = (res.rows as Row[]).map((r) => ({
        ref: String(r.ref),
        detail: String(r.detail),
        link: r.link ? String(r.link) : null,
      }));
      const open = rows.filter((r) => !ackOf.has(`${c.id}|${r.ref}`));
      checks.push({
        ...common,
        severity: c.severity,
        count: open.length,
        samples: open.slice(0, SAMPLES),
        accepted: rows
          .filter((r) => ackOf.has(`${c.id}|${r.ref}`))
          .slice(0, 50)
          .map((r) => ({ ...r, note: ackOf.get(`${c.id}|${r.ref}`) ?? null })),
      });
    } catch (e) {
      checks.push({
        ...common,
        severity: 'error',
        ackable: false,
        count: 1,
        samples: [
          {
            ref: 'contrôle',
            detail: `Échec de la vérification : ${(e as Error).message}`,
            link: null,
          },
        ],
        accepted: [],
      });
    }
  }
  return {
    at: new Date().toISOString(),
    errors: checks.filter((c) => c.severity === 'error').reduce((n, c) => n + c.count, 0),
    warnings: checks.filter((c) => c.severity === 'warning').reduce((n, c) => n + c.count, 0),
    checks,
  };
}

/** Last result, shown on the administrator’s home page without re-running the checks. */
let last: IntegrityReport | null = null;
export const lastIntegrity = () => last;

export const integrityRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db },
) => {
  const guard = { preHandler: app.requireRoles('ADMIN', 'COMPTA') };
  const key = z.object({ checkId: z.string().max(20), ref: z.string().min(1).max(200) });

  app.get('/admin/integrity', guard, async () => {
    last = await runIntegrityChecks(db);
    return last;
  });

  /** The table of items and figures behind a check, as JSON or Excel. */
  app.get(
    '/admin/integrity/:id/analysis',
    {
      ...guard,
      schema: {
        params: z.object({ id: z.string().max(20) }),
        querystring: z.object({ format: z.enum(['json', 'xlsx']).default('json') }),
      },
    },
    async (req, reply) => {
      const table = await integrityAnalysis(db, req.params.id);
      if (!table) throw notFound('Pas d’analyse détaillée pour ce contrôle.');
      if (req.query.format === 'json') return table;
      return reply
        .header('content-disposition', `attachment; filename="analyse-${req.params.id}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(await reportXlsx(table));
    },
  );

  /** Recomputes a derived figure from its source of truth (see FIXES). */
  app.post(
    '/admin/integrity/:id/fix',
    { ...guard, schema: { params: z.object({ id: z.string().max(20) }) } },
    async (req) => {
      const fix = FIXES[req.params.id];
      if (!fix) throw notFound('Aucune correction automatique pour ce contrôle.');
      const fixed = await db.transaction(async (tx) => {
        const n = await fix.run(tx as unknown as Db);
        await audit(tx, req, {
          action: 'integrity.fix',
          entity: 'integrity_check',
          entityId: req.params.id,
          after: { rows: n },
        });
        return n;
      });
      last = await runIntegrityChecks(db);
      return { fixed };
    },
  );

  /** A reviewed warning is set aside (kept visible under "acceptés"); errors cannot be accepted. */
  app.post(
    '/admin/integrity/accept',
    { ...guard, schema: { body: key.extend({ note: z.string().trim().max(300).optional() }) } },
    async (req) => {
      const check = INTEGRITY_CHECKS.find((c) => c.id === req.body.checkId);
      if (!check) throw notFound('Contrôle inconnu.');
      if (check.severity !== 'warning')
        throw badRequest('Une anomalie de calcul ne peut pas être acceptée : corrigez-la.');
      await db.transaction(async (tx) => {
        await tx
          .insert(integrityAck)
          .values({
            checkId: check.id,
            ref: req.body.ref,
            note: req.body.note || null,
            by: req.user!.id,
          })
          .onConflictDoUpdate({
            target: [integrityAck.checkId, integrityAck.ref],
            set: { note: req.body.note || null, by: req.user!.id, at: new Date() },
          });
        await audit(tx, req, {
          action: 'integrity.accept',
          entity: 'integrity_check',
          entityId: check.id,
          after: { ref: req.body.ref, note: req.body.note ?? null },
        });
      });
      last = await runIntegrityChecks(db);
      return { ok: true };
    },
  );

  app.post('/admin/integrity/unaccept', { ...guard, schema: { body: key } }, async (req) => {
    await db.transaction(async (tx) => {
      await tx
        .delete(integrityAck)
        .where(and(eq(integrityAck.checkId, req.body.checkId), eq(integrityAck.ref, req.body.ref)));
      await audit(tx, req, {
        action: 'integrity.unaccept',
        entity: 'integrity_check',
        entityId: req.body.checkId,
        after: { ref: req.body.ref },
      });
    });
    last = await runIntegrityChecks(db);
    return { ok: true };
  });
};

/** Nightly run: failures are logged as errors so they are noticed even if nobody opens the page. */
export function startIntegrityJob(db: Db, log: FastifyBaseLogger): () => void {
  const run = () =>
    runIntegrityChecks(db)
      .then((r) => {
        last = r;
        if (r.errors)
          log.error(
            { errors: r.errors, checks: r.checks.filter((c) => c.count) },
            'contrôles d’intégrité en échec',
          );
        else if (r.warnings)
          log.warn({ warnings: r.warnings }, 'contrôles d’intégrité : points à revoir');
      })
      .catch((err) => log.error({ err }, 'contrôles d’intégrité'));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 24 * 3600_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
