import { eq, sql } from 'drizzle-orm';
import { member, type Db, type Tx } from '@episoft/db';
import { inactivityCutoff } from '@episoft/shared';
import { anonymizeMember } from '../../members/anonymize';

// Spec Q8 (RGPD): a member who has been inactive for N years is anonymised. « Activity » is the
// latest of: signing in, a purchase (the member's or the household's), a movement of the cagnotte,
// a payment, a membership still running or ended, a pre-order, or the creation of the record.
// Someone who still has a cagnotte balance, an open obligation or a role is never a candidate:
// the exclusions are listed, not hidden.

export type ExclusionReason =
  'BALANCE' | 'ROLE' | 'OPEN_PREORDER' | 'OPEN_FEEDBACK' | 'PENDING_EMAIL';

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  BALANCE: 'Cagnotte non nulle',
  ROLE: 'A un rôle dans l’application',
  OPEN_PREORDER: 'Précommande en cours',
  OPEN_FEEDBACK: 'Signalement ouvert',
  PENDING_EMAIL: 'Courriel en attente d’envoi',
};

export interface InactiveRow {
  id: string;
  number: number;
  name: string;
  status: string;
  lastActivity: string;
  /** Empty: can be anonymised. */
  excluded: ExclusionReason[];
}

export interface InactiveReport {
  cutoff: string;
  years: number;
  candidates: InactiveRow[];
  excluded: InactiveRow[];
}

type Raw = {
  id: string;
  number: number;
  last_name: string;
  first_name: string;
  status: string;
  last_activity: Date | string;
  has_role: boolean;
  has_balance: boolean;
  open_preorder: boolean;
  open_feedback: boolean;
  pending_email: boolean;
};

/** Members whose last activity is before the cutoff, split into those that can go and those that cannot. */
export async function inactiveMembers(
  db: Db | Tx,
  years: number,
  now: Date,
  onlyId: string | null = null,
): Promise<InactiveReport> {
  const cutoff = inactivityCutoff(now, years);
  const res = await db.execute<Raw>(sql`
    with base as (
      select m.id, m.number, m.last_name, m.first_name, m.status, m.household_id, m.email,
        greatest(
          m.created_at,
          (select max(l.at) from app.login_log l where l.member_id = m.id and l.success),
          (select max(s.sold_at) from app.sale s where s.member_id = m.id),
          (select max(po.created_at) from app.preorder po where po.member_id = m.id),
          case when m.household_id is not null then greatest(
            (select max(s.sold_at) from app.sale s where s.household_id = m.household_id),
            (select max(w.at) from app.wallet_entry w where w.household_id = m.household_id),
            (select max(ms.end_date)::timestamptz from app.membership ms
              where ms.household_id = m.household_id and ms.cancelled_at is null),
            (select max(p.date)::timestamptz from app.member_payment p where p.household_id = m.household_id),
            (select max(po.created_at) from app.preorder po where po.household_id = m.household_id),
            (select max(l.at) from app.login_log l join app.member o on o.id = l.member_id
              where o.household_id = m.household_id and l.success)
          ) end
        ) as last_activity
      from app.member m
      -- Already anonymised: nothing left to do.
      where not (m.status = 'ARCHIVED' and m.first_name = '-' and m.last_name like 'Membre #%')
    )
    select b.id, b.number, b.last_name, b.first_name, b.status, b.last_activity,
           exists (select 1 from app.user_role r where r.member_id = b.id) as has_role,
           coalesce((select hb.balance from app.household_balance hb where hb.household_id = b.household_id), 0) <> 0 as has_balance,
           exists (select 1 from app.preorder po
                    where po.status in ('SUBMITTED', 'READY')
                      and (po.member_id = b.id or (b.household_id is not null and po.household_id = b.household_id))) as open_preorder,
           exists (select 1 from app.feedback_ticket f
                    where f.author_id = b.id and f.status in ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'TO_TEST')) as open_feedback,
           (b.email is not null and exists (select 1 from app.email_outbox e
                    where e.status = 'PENDING' and lower(e."to") like '%' || lower(b.email) || '%')) as pending_email
      from base b
     where b.last_activity < ${cutoff.toISOString()}::timestamptz
       and (${onlyId}::uuid is null or b.id = ${onlyId}::uuid)
     order by b.last_activity, b.number`);
  const rows: InactiveRow[] = res.rows.map((r) => ({
    id: r.id,
    number: r.number,
    name: `${r.first_name} ${r.last_name}`.trim(),
    status: r.status,
    lastActivity: new Date(r.last_activity).toISOString(),
    excluded: (
      [
        r.has_balance && 'BALANCE',
        r.has_role && 'ROLE',
        r.open_preorder && 'OPEN_PREORDER',
        r.open_feedback && 'OPEN_FEEDBACK',
        r.pending_email && 'PENDING_EMAIL',
      ] as (ExclusionReason | false)[]
    ).filter((x): x is ExclusionReason => !!x),
  }));
  return {
    cutoff: cutoff.toISOString(),
    years,
    candidates: rows.filter((r) => !r.excluded.length),
    excluded: rows.filter((r) => r.excluded.length),
  };
}

/**
 * Anonymises the candidates (or the given ones among them: an id that is not a candidate any more
 * is skipped, never forced). One transaction per member; the guards are re-checked inside it.
 * `record` writes the journal entry of each (the same action as the manual button).
 */
export async function anonymizeInactive(
  db: Db,
  years: number,
  now: Date,
  record: (tx: Tx, m: { id: string; number: number }) => Promise<void>,
  opts: { ids?: string[]; limit?: number } = {},
): Promise<number> {
  const report = await inactiveMembers(db, years, now);
  let todo = report.candidates;
  if (opts.ids) todo = todo.filter((c) => opts.ids!.includes(c.id));
  if (opts.limit) todo = todo.slice(0, opts.limit);
  let done = 0;
  for (const c of todo) {
    const ok = await db.transaction(async (tx) => {
      const [m] = await tx.select().from(member).where(eq(member.id, c.id)).for('update');
      if (!m) return false;
      // Re-check under the lock: something may have happened since the list was built.
      const again = await inactiveMembers(tx, years, now, c.id);
      if (!again.candidates.some((x) => x.id === c.id)) return false;
      await anonymizeMember(tx, m, () => record(tx, m));
      return true;
    });
    if (ok) done++;
  }
  return done;
}
