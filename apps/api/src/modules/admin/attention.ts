import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '@episoft/db';
import { DEFAULT_THRESHOLDS, type Thresholds } from '@episoft/shared';
import { EMAIL_DISABLED_NOTE } from '../../lib/mail';
import { backupRun, emailOutbox, integrityRun, syncRejection, errorLog } from '@episoft/db';

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

  add({
    code: 'SALE_WARNINGS',
    severity: 'warning',
    count: await count(sql`select count(*)::int as n from app.sale
      where warnings is not null and jsonb_array_length(warnings) > 0
        and warnings_reviewed_at is null and sold_at > now() - interval '30 days'`),
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
      where status = 'NEW' and date < current_date - 30`),
    label: 'Ligne(s) bancaire(s) à rapprocher depuis plus d’un mois.',
    link: '/compta/banque',
  });

  const [errs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(errorLog)
    .where(
      and(
        isNull(errorLog.acknowledgedAt),
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

  const rank = { error: 0, warning: 1 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
