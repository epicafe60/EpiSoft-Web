import { asc, sql } from 'drizzle-orm';
import { fiscalJournal, periodClosing, type Db } from '@episoft/db';
import {
  canonicalJson,
  CASH_PAYMENT_LIMIT_CENTS,
  centsToDecimal,
  computePeriodTotals,
  decimalToCents,
  nextGrandTotal,
  verifyJournalChain,
  type JournalRow,
} from '@episoft/shared';
import { closingDocs } from './periods';
import { fiscalSealKey, saleSealData, SALE_KINDS } from './journal';

// ADR 0016: the checks of the inalterable till. They recompute (chain, tickets, closings) instead
// of reading what was stored, so that a figure changed in the database, even by its owner, shows.

export interface FiscalFinding {
  id: string;
  label: string;
  severity: 'error' | 'warning';
  rows: { ref: string; detail: string; link: string | null }[];
}

export const FISCAL_HELP: Record<string, { what: string; todo: string }> = {
  'FIS-01': {
    what: 'Chaque ticket, annulation ou avoir a été scellé dans le journal de la caisse au moment où il a été enregistré. Ses montants, lignes et paiements actuels doivent être identiques à ceux du scellé.',
    todo: 'Un ticket a été modifié ou supprimé hors de l’application, ou son scellé manque. Ne corrigez rien à la main : conservez l’archive fiscale, comparez avec une sauvegarde et prévenez l’équipe technique.',
  },
  'FIS-02': {
    what: 'Le journal de la caisse est une chaîne : chaque entrée contient l’empreinte de la précédente et porte une signature. La vérification refait tous les calculs.',
    todo: 'Une entrée a été modifiée, supprimée ou ajoutée hors de l’application. Restaurez la dernière sauvegarde saine et comparez avec l’archive fiscale la plus récente.',
  },
  'FIS-03': {
    what: 'Chaque poste numérote ses documents sans trou et les scelle l’un après l’autre, même hors ligne. Le serveur a trouvé un scellé invalide, un numéro réutilisé, un numéro manquant ou une chaîne rompue.',
    todo: 'Ouvrez le ticket : un document du poste n’est pas arrivé, ou a été falsifié, ou le poste a été réinitialisé. Retrouvez le document manquant sur le poste avant de l’effacer. Les tickets restent enregistrés.',
  },
  'FIS-04': {
    what: 'Les clôtures (jour, mois, année) fixent les totaux par taux de TVA et par moyen de paiement, avec un cumul perpétuel qui ne baisse jamais. Elles doivent égaler le recalcul des tickets de la période, et aucun ticket ne doit s’ajouter après coup.',
    todo: 'Ne modifiez pas la clôture. Un ticket ou une clôture a changé hors de l’application : comparez avec une sauvegarde et l’archive fiscale.',
  },
  'FIS-05': {
    what: 'Un paiement en espèces ne peut pas dépasser 1 000 € pour un consommateur résident en France (art. D112-3 du code monétaire et financier). La caisse le refuse ; un ticket arrivé d’un ancien poste est quand même enregistré.',
    todo: 'Vérifiez le ticket avec la personne qui a encaissé et régularisez avec le client (autre moyen de paiement pour l’excédent).',
  },
  'FIS-06': {
    what: 'Les entrées du journal sont signées avec une clé gardée hors de la base (FISCAL_SEAL_KEY). Sans elle, quelqu’un qui contrôle la base peut recalculer toute la chaîne.',
    todo: 'Demandez à l’équipe technique de poser la clé dans les réglages du serveur (32 caractères aléatoires au moins) puis de redémarrer l’application.',
  },
  'FIS-07': {
    what: 'Tous les tickets récents sont scellés par le poste. Ceux-ci ne le sont pas : ils viennent d’un poste qui n’a pas été mis à jour.',
    todo: 'Rechargez la page de la caisse sur ce poste pour obtenir la dernière version, puis vérifiez que ses tickets sont scellés.',
  },
};

const link = (_saleId: string): string | null => null;

export async function fiscalFindings(db: Db): Promise<FiscalFinding[]> {
  const out: FiscalFinding[] = [];
  const key = fiscalSealKey();

  // --- FIS-02: the chain ---
  const journal = await db.select().from(fiscalJournal).orderBy(asc(fiscalJournal.seq));
  const asRows: JournalRow[] = journal.map((j) => ({
    seq: j.seq,
    at: j.at.toISOString(),
    kind: j.kind,
    data: j.data,
    prevHash: j.prevHash,
    hash: j.hash,
    signature: j.signature,
  }));
  const breaks = await verifyJournalChain(asRows, { key, startPrev: '0'.repeat(64) });
  out.push({
    id: 'FIS-02',
    label: 'Le journal de la caisse est une chaîne intacte et signée',
    severity: 'error',
    rows: breaks.map((b) => ({ ref: `entrée ${b.seq}`, detail: b.detail, link: null })),
  });
  // A hole at the end (the last entries deleted) shows against the counter of the journal.
  const [counter] = (
    await db.execute<{ value: number }>(
      sql`select value from app.number_counter where key = 'fiscal_journal'`,
    )
  ).rows;
  if (counter && counter.value !== (asRows.at(-1)?.seq ?? 0))
    out[out.length - 1]!.rows.push({
      ref: 'fin du journal',
      detail: `le compteur est à ${counter.value} mais la dernière entrée est la ${asRows.at(-1)?.seq ?? 0}`,
      link: null,
    });

  // --- FIS-01: tickets against their seal ---
  const f01: FiscalFinding['rows'] = [];
  for (const j of journal) {
    if (!(SALE_KINDS as readonly string[]).includes(j.kind)) continue;
    const now = await saleSealData(db, j.refId).catch(() => null);
    if (!now) {
      f01.push({ ref: `entrée ${j.seq}`, detail: 'le ticket scellé n’existe plus', link: null });
    } else if (canonicalJson(now) !== canonicalJson(j.data)) {
      f01.push({
        ref: String((j.data as { number?: string }).number ?? `entrée ${j.seq}`),
        detail: 'le ticket ne correspond plus à son scellé (montant, ligne, paiement ou date modifié)',
        link: link(j.refId),
      });
    }
  }
  if (journal.length) {
    const start = journal[0]!.at;
    const unsealed = await db.execute<{ id: string; number: string }>(
      sql`select id, number from app.sale
          where legacy_ref is null and created_at >= ${start.toISOString()}::timestamptz - interval '1 second'
            and not exists (select 1 from app.fiscal_journal j where j.ref_type = 'sale' and j.ref_id = sale.id)`,
    );
    for (const r of unsealed.rows)
      f01.push({ ref: r.number, detail: 'ticket enregistré sans scellé dans le journal', link: link(r.id) });
  }
  out.push({
    id: 'FIS-01',
    label: 'Chaque ticket est identique à son scellé',
    severity: 'error',
    rows: f01,
  });

  // --- FIS-03 and FIS-07: the registers' seals ---
  const seals = await db.execute<{ id: string; number: string; st: string; no: string | null }>(
    sql`select id, number, till_seal_status as st, provisional_number as no from app.sale
        where till_seal_status is not null and till_seal_status not in ('OK', 'ABSENT')
        order by sold_at`,
  );
  out.push({
    id: 'FIS-03',
    label: 'Les documents de chaque poste sont numérotés sans trou et scellés en chaîne',
    severity: 'error',
    rows: seals.rows.map((r) => ({
      ref: r.number,
      detail: `${r.no ?? ''} : scellé du poste ${r.st}`,
      link: link(r.id),
    })),
  });
  const absent = await db.execute<{ id: string; number: string }>(
    sql`select id, number from app.sale s
        where till_seal_status = 'ABSENT' and legacy_ref is null
          and exists (select 1 from app.sale k where k.till_seal_status = 'OK' and k.created_at < s.created_at)
        order by sold_at`,
  );
  out.push({
    id: 'FIS-07',
    label: 'Les tickets récents portent le scellé de leur poste',
    severity: 'warning',
    rows: absent.rows.map((r) => ({
      ref: r.number,
      detail: 'ticket sans scellé du poste',
      link: link(r.id),
    })),
  });

  // --- FIS-04: closings ---
  const f04: FiscalFinding['rows'] = [];
  const closings = await db.select().from(periodClosing).orderBy(asc(periodClosing.periodStart));
  let gt: string | null = null;
  for (const c of closings) {
    const ref = `${c.kind} ${c.periodStart}`;
    const totals = computePeriodTotals(await closingDocs(db, c.periodStart, c.periodEnd));
    if (canonicalJson(totals) !== canonicalJson(c.totals))
      f04.push({ ref, detail: 'les totaux ne correspondent plus aux tickets de la période', link: null });
    const [late] = (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from app.sale
            where accounting_day between ${c.periodStart}::date and ${c.periodEnd}::date and created_at > ${c.closedAt.toISOString()}::timestamptz`,
      )
    ).rows;
    if (late && late.n > 0)
      f04.push({ ref, detail: `${late.n} ticket(s) ajouté(s) après la clôture`, link: null });
    if (c.kind === 'DAY') {
      if (gt !== null) {
        const expected = nextGrandTotal(gt, totals.absoluteTotal);
        if (decimalToCents(c.grandTotal) !== decimalToCents(expected))
          f04.push({
            ref,
            detail: `cumul perpétuel ${c.grandTotal} au lieu de ${expected}`,
            link: null,
          });
      }
      if (gt !== null && decimalToCents(c.grandTotal) < decimalToCents(gt))
        f04.push({ ref, detail: 'le cumul perpétuel a baissé', link: null });
      gt = c.grandTotal;
    }
    const j = journal.find((x) => x.seq === c.journalSeq);
    if (!j || (j.data as { id?: string }).id !== c.id)
      f04.push({ ref, detail: 'la clôture n’est pas dans le journal', link: null });
  }
  out.push({
    id: 'FIS-04',
    label: 'Les clôtures égalent le recalcul des tickets, le cumul perpétuel ne baisse jamais',
    severity: 'error',
    rows: f04,
  });

  // --- FIS-05: the cash ceiling ---
  const cash = await db.execute<{ id: string; number: string; amount: string }>(
    sql`select s.id, s.number, p.amount::text as amount
        from app.sale_payment p join app.sale s on s.id = p.sale_id
        where p.method = 'CASH' and p.amount > ${centsToDecimal(CASH_PAYMENT_LIMIT_CENTS)}::numeric
        order by s.sold_at`,
  );
  out.push({
    id: 'FIS-05',
    label: 'Aucun paiement en espèces ne dépasse le plafond légal',
    severity: 'warning',
    rows: cash.rows.map((r) => ({
      ref: r.number,
      detail: `${r.amount} € en espèces (plafond ${centsToDecimal(CASH_PAYMENT_LIMIT_CENTS)} €)`,
      link: link(r.id),
    })),
  });

  // --- FIS-06: the key ---
  out.push({
    id: 'FIS-06',
    label: 'Le journal de la caisse est signé avec une clé hors de la base',
    severity: 'warning',
    rows:
      !key && journal.length
        ? [{ ref: 'FISCAL_SEAL_KEY', detail: 'clé de signature non configurée', link: null }]
        : [],
  });
  return out;
}
