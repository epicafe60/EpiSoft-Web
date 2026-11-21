import { sql } from 'drizzle-orm';
import type { Tx } from '../index';
import type { Report } from './lot1';
import { importOptions } from './options';

// What the imported data still lacks against the rules of the new application (food information,
// « bio » and « local » claims, prices, consents, seals). Nothing is invented: the import keeps
// what the old software knew, and this sheet lists what a person has to complete or confirm.

interface Finding {
  check: string;
  count: number;
  examples: string;
  action: string;
}

const one = async (tx: Tx, query: ReturnType<typeof sql>) =>
  Number(((await tx.execute(query)).rows[0] as { n: string } | undefined)?.n ?? 0);
const codes = async (tx: Tx, query: ReturnType<typeof sql>) =>
  ((await tx.execute(query)).rows as { c: string }[]).map((r) => r.c).join(', ');

export async function reportCompliance(tx: Tx, r: Report): Promise<void> {
  const findings: Finding[] = [];
  const add = async (
    check: string,
    count: ReturnType<typeof sql>,
    examples: ReturnType<typeof sql> | null,
    action: string,
  ) => {
    const n = await one(tx, count);
    findings.push({
      check,
      count: n,
      examples: n && examples ? await codes(tx, examples) : '',
      action,
    });
  };

  await add(
    'Produits alimentaires (univers 1 à 4) sans décision sur les allergènes',
    sql`select count(*)::int as n from app.product where is_food and allergens_decision is null`,
    sql`select code as c from app.product where is_food and allergens_decision is null order by code limit 5`,
    'À compléter si l’option « information du consommateur » est activée (Administration › Paramètres).',
  );
  await add(
    'Produits « bio » sans certificat valide du fournisseur',
    sql`select count(*)::int as n from app.product p left join app.supplier s on s.id = p.supplier_id
         where 'ORGANIC' = any(p.qualities)
           and (s.organic_cert_number is null or s.organic_cert_expiry is null or s.organic_cert_expiry < current_date)`,
    sql`select p.code as c from app.product p left join app.supplier s on s.id = p.supplier_id
         where 'ORGANIC' = any(p.qualities)
           and (s.organic_cert_number is null or s.organic_cert_expiry is null or s.organic_cert_expiry < current_date)
         order by p.code limit 5`,
    'Saisir le certificat du fournisseur (numéro, organisme, échéance) ou retirer la mention. Sans certificat, la mention n’est ni affichée en ligne ni imprimée.',
  );
  await add(
    'Produits « local » sans justification',
    sql`select count(*)::int as n from app.product where 'LOCAL' = any(qualities) and coalesce(trim(local_justification), '') = ''`,
    sql`select code as c from app.product where 'LOCAL' = any(qualities) and coalesce(trim(local_justification), '') = '' order by code limit 5`,
    'Indiquer le producteur et la distance, ou retirer la mention. Les autres modifications de la fiche ne sont pas bloquées.',
  );
  await add(
    'Produits vendus sous leur prix d’achat HT',
    sql`select count(*)::int as n from app.product
         where kind = 'GOODS' and purchase_price_excl is not null and purchase_price_excl > 0
           and sale_price / (1 + vat_rate / 100) < purchase_price_excl`,
    sql`select code as c from app.product
         where kind = 'GOODS' and purchase_price_excl is not null and purchase_price_excl > 0
           and sale_price / (1 + vat_rate / 100) < purchase_price_excl order by code limit 5`,
    'Revente à perte (art. L442-5 du Code de commerce) : corriger le prix ; la fiche existante n’est pas bloquée tant que ce prix n’est pas modifié.',
  );
  await add(
    'Marchandises à 0 € de prix de vente',
    sql`select count(*)::int as n from app.product where kind = 'GOODS' and sale_price = 0`,
    sql`select code as c from app.product where kind = 'GOODS' and sale_price = 0 order by code limit 5`,
    'Renseigner le prix de vente.',
  );
  await add(
    'Adhérents sans trace de consentement',
    sql`select count(*)::int as n from app.member m where not exists (select 1 from app.consent c where c.member_id = m.id)`,
    null,
    'Aucun consentement n’est inventé : à recueillir (courriel d’information, case à cocher à la prochaine visite).',
  );
  await add(
    'Tickets repris de l’ancien logiciel, sans scellé',
    sql`select count(*)::int as n from app.sale where legacy_ref is not null and till_seal_status is null`,
    null,
    'Voulu (ADR 0016) : ces tickets n’ont jamais été scellés, ils ne le sont pas après coup. Le journal chaîné commence à la mise en service.',
  );
  await add(
    'Stock initial sans coût connu',
    sql`select count(*)::int as n from app.stock_movement where kind = 'INITIAL' and source_type = 'legacy' and avg_cost_after is null`,
    sql`select p.code as c from app.stock_movement m join app.product p on p.id = m.product_id
         where m.kind = 'INITIAL' and m.source_type = 'legacy' and m.avg_cost_after is null order by p.code limit 5`,
    'Renseigner le prix d’achat : la valeur du stock est calculée au coût moyen.',
  );
  // Without VAT to recover (franchise, exempt) no breakdown is made: nothing to say about it.
  if (importOptions.vatRegime === 'LIABLE')
    await add(
      'Factures dont la TVA n’a pas pu être ventilée sur un taux exact',
      sql`select count(*)::int as n from app.supplier_invoice i
         where i.legacy_factid is not null and not exists (select 1 from app.supplier_invoice_vat_line l where l.invoice_id = i.id)`,
      null,
      'Voir les anomalies « facture » : ventilation estimée ou absente, à vérifier.',
    );
  await add(
    `Tickets repris au régime de TVA « ${importOptions.vatRegime} »`,
    sql`select count(*)::int as n from app.sale where legacy_ref is not null and vat_regime = ${importOptions.vatRegime}::app.vat_regime`,
    null,
    'À confirmer avec l’expert-comptable. Exonéré (art. 261 du CGI) : ni TVA facturée ni récupérable, mention sur les tickets, pas de ventilation des factures. Pour un autre régime : relancer avec --vat-regime, ou l’enregistrer avec sa date d’effet (Administration › Paramètres).',
  );

  r.sheets.push({
    name: 'Conformité',
    columns: [
      { header: 'Contrôle', key: 'check', width: 62 },
      { header: 'Nombre', key: 'count', width: 10 },
      { header: 'Exemples (codes)', key: 'examples', width: 38 },
      { header: 'Suite à donner', key: 'action', width: 110 },
    ],
    rows: findings,
  });
  for (const f of findings.filter((x) => x.count > 0))
    r.counts.push({ table: 'conformité', source: f.count, migrated: f.count, note: f.check });
}
