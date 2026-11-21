import { and, desc, eq, gt, isNull, lt, notLike, sql } from 'drizzle-orm';
import type { Db } from '@episoft/db';
import { DEFAULT_THRESHOLDS, legalGaps, type Thresholds } from '@episoft/shared';
import { toShopDate, tzSql } from '../../lib/dates';
import { EMAIL_DISABLED_NOTE } from '../../lib/mail';
import { REFUSAL_PREFIX } from '../../plugins/errors';
import { backupRun, emailOutbox, integrityRun, syncRejection, errorLog } from '@episoft/db';
import { loadSettings } from './settings-store';
import { diskSpace, totalDatabaseBytes } from './retention/size';

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024).toLocaleString('fr-FR')} Mo`;

/** One thing that needs a human look, as shown in the « À surveiller » block. */
export interface AttentionItem {
  code: string;
  severity: 'error' | 'warning';
  count: number;
  label: string;
  /** App page where it can be dealt with. */
  link: string;
}

const HOUR = 3_600_000;

/**
 * Everything that deserves a look, in one list: the home screen block, the menu badge and the
 * daily summary e-mail all read it. Read-only, a handful of cheap queries.
 */
export async function computeAttention(
  db: Db,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  now = new Date(),
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const add = (i: AttentionItem) => {
    if (i.count > 0) items.push(i);
  };
  const count = async (q: ReturnType<typeof sql>) =>
    Number(((await db.execute<{ n: number }>(q)).rows[0] as { n: number }).n);

  const [run] = await db.select().from(integrityRun).orderBy(desc(integrityRun.at)).limit(1);
  if (run) {
    add({
      code: 'INTEGRITY_ERRORS',
      severity: 'error',
      count: run.errors,
      label: 'Contrôle(s) de cohérence en échec : un calcul de l’application est faux.',
      link: '/admin/controles',
    });
    add({
      code: 'INTEGRITY_WARNINGS',
      severity: 'warning',
      count: run.warnings,
      label: 'Point(s) à revoir dans les contrôles de cohérence.',
      link: '/admin/controles',
    });
  }

  const [rej] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(syncRejection)
    .where(isNull(syncRejection.acknowledgedAt));
  add({
    code: 'REJECTED_TICKETS',
    severity: 'error',
    count: rej!.n,
    label: 'Ticket(s) de caisse refusé(s) par le serveur : à ressaisir ou à classer.',
    link: '/surveillance',
  });

  // A sale that broke a rule of the association (discount, transfer, member, price…) went through
  // because the ticket was already printed: it stays here, as an error, until someone reviews it.
  const blocking = sql`exists (select 1 from jsonb_array_elements(warnings) w where w ->> 'severity' = 'blocking')`;
  add({
    code: 'SALE_POLICY_BREACH',
    severity: 'error',
    count: await count(sql`select count(*)::int as n from app.sale
      where warnings is not null and warnings_reviewed_at is null and ${blocking}`),
    label:
      'Ticket(s) vendu(s) en dehors des règles de la boutique (remise, virement, prix, adhérent…) : à vérifier.',
    link: '/surveillance',
  });
  add({
    code: 'SALE_WARNINGS',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.sale
      where warnings is not null and jsonb_array_length(warnings) > 0
        and warnings_reviewed_at is null and sold_at > now() - interval '30 days'
        and not ${blocking}`),
    label: 'Ticket(s) enregistré(s) avec un avertissement (prix inhabituel, stock négatif…).',
    link: '/surveillance',
  });

  const [failed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, 'FAILED'),
        gt(emailOutbox.createdAt, new Date(now.getTime() - 7 * 24 * HOUR)),
        sql`${emailOutbox.lastError} is distinct from ${EMAIL_DISABLED_NOTE}`,
      ),
    );
  add({
    code: 'EMAILS_FAILED',
    severity: 'warning',
    count: failed!.n,
    label: 'Courriel(s) non envoyé(s) ces 7 derniers jours.',
    link: '/surveillance/courriels',
  });
  const [stuck] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, 'PENDING'),
        lt(emailOutbox.createdAt, new Date(now.getTime() - HOUR)),
      ),
    );
  add({
    code: 'EMAILS_STUCK',
    severity: 'warning',
    count: stuck!.n,
    label: 'Courriel(s) en attente depuis plus d’une heure (le serveur de messagerie répond-il ?).',
    link: '/surveillance/courriels',
  });

  add({
    code: 'SESSION_OLD',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.cash_session
      where status = 'OPEN' and opened_at < now() - make_interval(hours => ${thresholds.sessionHours})`),
    label: 'Session(s) de caisse ouverte(s) depuis plus d’une journée : à clôturer.',
    link: '/admin/caisse',
  });
  add({
    code: 'STOCK_NEGATIVE',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.product
      where kind = 'GOODS' and status <> 'INACTIVE' and stock_qty < 0`),
    label: 'Produit(s) avec un stock négatif : une réception ou un inventaire manque.',
    link: '/catalogue',
  });
  add({
    code: 'WALLET_NEGATIVE',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.household_balance where balance < 0`),
    label: 'Foyer(s) avec une cagnotte négative.',
    link: '/membres',
  });
  add({
    code: 'DRAFT_ENTRIES',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.entry
      where status = 'DRAFT' and created_at < now() - interval '7 days'`),
    label: 'Écriture(s) comptable(s) en brouillon depuis plus d’une semaine.',
    link: '/compta/ecritures',
  });
  add({
    code: 'BANK_TO_MATCH',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.bank_line
      where status = 'NEW' and date < (now() at time zone ${tzSql()})::date - 30`),
    label: 'Ligne(s) bancaire(s) à rapprocher depuis plus d’un mois.',
    link: '/compta/banque',
  });

  // Compliance: product information (règlement UE 1169/2011), « bio » and « local » claims
  // (règlement UE 2018/848, DGCCRF), public legal pages (LCEN, RGPD).
  add({
    code: 'FOOD_INFO_MISSING',
    severity: 'error',
    count: await count(sql`select count(*)::int as n from app.product
      where is_food and kind = 'GOODS' and status <> 'INACTIVE'
        and (allergens_decision is null or length(trim(coalesce(ingredients, ''))) < 2)`),
    label:
      'Produit(s) alimentaire(s) sans décision sur les allergènes ou sans ingrédients : non proposés en ligne, étiquette refusée.',
    link: '/catalogue',
  });
  const today = toShopDate(now);
  add({
    code: 'ORGANIC_CERT_INVALID',
    severity: 'error',
    count: await count(sql`select count(*)::int as n from app.product p
      left join app.supplier s on s.id = p.supplier_id
      where 'ORGANIC' = any(p.qualities) and p.status <> 'INACTIVE'
        and (s.id is null or s.organic_cert_number is null or s.organic_cert_body is null
             or s.organic_cert_expiry is null or s.organic_cert_expiry < ${today}::date)`),
    label:
      'Produit(s) « bio » dont le fournisseur n’a pas de certificat bio valide : la mention bio ne doit plus être employée.',
    link: '/appros/fournisseurs',
  });
  add({
    code: 'ORGANIC_CERT_EXPIRING',
    severity: 'warning',
    count: await count(sql`select count(distinct s.id)::int as n from app.supplier s
      join app.product p on p.supplier_id = s.id
      where 'ORGANIC' = any(p.qualities) and p.status <> 'INACTIVE'
        and s.organic_cert_expiry >= ${today}::date
        and s.organic_cert_expiry < ${today}::date + 30`),
    label: 'Certificat(s) bio de fournisseur qui expirent dans moins de 30 jours.',
    link: '/appros/fournisseurs',
  });
  add({
    code: 'LOCAL_UNJUSTIFIED',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.product
      where 'LOCAL' = any(qualities) and status <> 'INACTIVE'
        and length(trim(coalesce(local_justification, ''))) < 8`),
    label: 'Produit(s) « local » sans justification (producteur, distance).',
    link: '/catalogue',
  });
  const legalSettings = await loadSettings(db);
  const gaps = legalGaps(legalSettings['association.identity'], legalSettings['legal.texts']);
  add({
    code: 'LEGAL_PAGES_INCOMPLETE',
    severity: 'warning',
    count: gaps.length,
    label: `Mentions légales incomplètes : il manque ${gaps.join(', ')}.`,
    link: '/admin/parametres',
  });

  const [errs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(errorLog)
    .where(
      and(
        isNull(errorLog.acknowledgedAt),
        // An entry refused by the validation is not a breakdown (see recordRefusal).
        notLike(errorLog.message, `${REFUSAL_PREFIX}%`),
        gt(errorLog.lastAt, new Date(now.getTime() - 7 * 24 * HOUR)),
      ),
    );
  add({
    code: 'SERVER_ERRORS',
    severity: 'error',
    count: errs!.n,
    label: 'Erreur(s) inattendue(s) du serveur ces 7 derniers jours.',
    link: '/surveillance/erreurs',
  });

  // Signalements nobody has looked at yet.
  add({
    code: 'FEEDBACK_NEW',
    severity: 'warning',
    count: await count(
      sql`select count(*)::int as n from app.feedback_ticket where status = 'NEW'`,
    ),
    label: 'Signalement(s) (problème ou idée) en attente d’une première réponse.',
    link: '/signalements/gestion',
  });

  // F1: wrong cashier codes in the last 24 h, beyond what a slip of the finger explains.
  const pinFails = await count(sql`select count(*)::int as n from app.till_pin_attempt
    where at > ${new Date(now.getTime() - 24 * HOUR)}`);
  add({
    code: 'PIN_GUESSING',
    severity: 'warning',
    count: pinFails >= 15 ? pinFails : 0,
    label: 'Code(s) caissier faux ces dernières 24 h : quelqu’un cherche peut-être à le deviner.',
    link: '/admin/connexions',
  });

  const [lastBackup] = await db
    .select()
    .from(backupRun)
    .where(and(eq(backupRun.kind, 'BACKUP'), eq(backupRun.ok, true)))
    .orderBy(desc(backupRun.at))
    .limit(1);
  const ageH = lastBackup ? (now.getTime() - lastBackup.at.getTime()) / HOUR : Infinity;
  if (ageH > thresholds.backupHours)
    items.push({
      code: 'BACKUP_LATE',
      severity: ageH > 48 ? 'error' : 'warning',
      count: 1,
      label: lastBackup
        ? `La dernière sauvegarde date de ${Math.floor(ageH)} h.`
        : 'Aucune sauvegarde n’a été signalée à l’application.',
      link: '/surveillance/sauvegardes',
    });

  // Size of the database and free space of the disk (ADR 0017): the thresholds are a setting.
  const { alerts } = (await loadSettings(db))['data.retention'];
  if (alerts.dbSizeMb !== null) {
    const bytes = await totalDatabaseBytes(db);
    if (bytes > alerts.dbSizeMb * 1024 * 1024)
      items.push({
        code: 'DB_SIZE',
        severity: 'warning',
        count: 1,
        label: `La base de données pèse ${mb(bytes)} (seuil : ${alerts.dbSizeMb} Mo) : voir la conservation des données.`,
        link: '/admin/base',
      });
  }
  if (alerts.diskFreePct !== null) {
    const disk = await diskSpace();
    if (disk && disk.freePct < alerts.diskFreePct)
      items.push({
        code: 'DISK_LOW',
        severity: disk.freePct < alerts.diskFreePct / 2 ? 'error' : 'warning',
        count: 1,
        label: `Il ne reste que ${disk.freePct.toFixed(0)} % d’espace libre sur le disque du serveur (${mb(disk.freeBytes)}).`,
        link: '/admin/base',
      });
  }

  const rank = { error: 0, warning: 1 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
