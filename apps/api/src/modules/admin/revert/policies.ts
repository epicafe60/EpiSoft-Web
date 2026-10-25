import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { memberPayment, walletEntry, type Tx } from '@episoft/db';
import {
  centsToDecimal,
  decimalToCents,
  formatEuro,
  parseQtyToMilli,
  type AuditAction,
  type RowChange,
} from '@episoft/shared';
import { toParisDate } from '../../../lib/dates';
import { reverseEntry } from '../../accounting/service';
import { lockedBalanceCents } from '../../pos/wallet';
import { recordMovement } from '../../stock/ledger';

// R-ADM-06: how each action of the journal is undone. Every action has a decision here (the
// compiler checks it):
// - restore: the previous values are put back (records, settings);
// - compensate: a counter-operation is recorded, history is never erased (cagnotte, stock,
//   validated entries);
// - via: the undo belongs to a business screen, which does what has to go with it (a ticket is
//   cancelled from the till: the money leaves the drawer of the day);
// - none: cannot be undone, with the reason.

export interface RevertContext {
  entry: { id: string; action: string; at: Date; after: unknown };
  changes: RowChange[];
}

export type Compensation = (
  tx: Tx,
  req: FastifyRequest,
  ctx: RevertContext,
  reason: string,
) => Promise<string>;

export type Policy =
  | { kind: 'restore' }
  | { kind: 'compensate'; label: string; run: Compensation }
  | { kind: 'via'; reason: string; link: string }
  | { kind: 'none'; reason: string };

type Resolver = Policy | ((ctx: RevertContext) => Policy);

const restore: Policy = { kind: 'restore' };
const none = (reason: string): Policy => ({ kind: 'none', reason });
const via = (reason: string, link: string): Policy => ({ kind: 'via', reason, link });

const inserted = (ctx: RevertContext, table: string) =>
  ctx.changes.filter((c) => c.table === table && c.op === 'I' && c.new).map((c) => c.new!);

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const dateFr = (d: Date) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' }).format(d);

/** A correction of the opposite amount on each cagnotte the action credited or debited. */
const oppositeCorrection =
  (what: string): Compensation =>
  async (tx, req, ctx, reason) => {
    const done: string[] = [];
    for (const e of inserted(ctx, 'wallet_entry')) {
      const cents = -decimalToCents(str(e.amount));
      await lockedBalanceCents(tx, str(e.household_id));
      await tx.insert(walletEntry).values({
        householdId: str(e.household_id),
        amount: centsToDecimal(cents),
        kind: 'CORRECTION',
        comment: `Annulation ${what} du ${dateFr(ctx.entry.at)} : ${reason}`,
        createdBy: req.user!.id,
      });
      done.push(formatEuro(centsToDecimal(cents)));
    }
    if (!done.length) throw new Error('Aucune opération de cagnotte à compenser.');
    return `Correction de cagnotte de ${done.join(', ')} enregistrée.`;
  };

/** R-CAG-08: a top-up entered today at the back office is simply withdrawn, as the screen does. */
const withdrawTopup: Compensation = async (tx, _req, ctx) => {
  const [e] = inserted(ctx, 'wallet_entry');
  await lockedBalanceCents(tx, str(e!.household_id));
  await tx.delete(walletEntry).where(eq(walletEntry.id, str(e!.id)));
  if (e!.payment_id) await tx.delete(memberPayment).where(eq(memberPayment.id, str(e!.payment_id)));
  return `Versement de ${formatEuro(str(e!.amount))} retiré (saisi le jour même).`;
};

const topup = (ctx: RevertContext): Policy => {
  const pay = inserted(ctx, 'member_payment')[0];
  const entry = inserted(ctx, 'wallet_entry')[0];
  if (!entry) return none('Aucune opération de cagnotte n’est rattachée à cette action.');
  if (pay?.cash_session_id)
    return none(
      'Versement fait en caisse : l’argent est dans le tiroir. Rendez-le à l’adhérent, puis passez une correction de cagnotte avec un motif depuis la fiche du foyer.',
    );
  if (toParisDate(ctx.entry.at) === toParisDate(new Date()))
    return {
      kind: 'compensate',
      label: 'Retirer le versement saisi aujourd’hui',
      run: withdrawTopup,
    };
  return {
    kind: 'compensate',
    label: 'Passer une correction de cagnotte du montant opposé',
    run: oppositeCorrection('du versement'),
  };
};

/** The opposite movement of each stock movement the action recorded. */
const oppositeStock: Compensation = async (tx, req, ctx, reason) => {
  const moves = inserted(ctx, 'stock_movement');
  if (!moves.length) throw new Error('Aucun mouvement de stock à compenser.');
  for (const m of moves)
    await recordMovement(tx, {
      productId: str(m.product_id),
      qtyMilli: -parseQtyToMilli(str(m.qty))!,
      kind: 'CORRECTION',
      unitCost: m.unit_cost === null ? null : str(m.unit_cost),
      comment: `Annulation du ${dateFr(ctx.entry.at)} : ${reason}`,
      by: req.user!.id,
      sourceType: 'revert',
      sourceId: str(m.id),
    });
  return `${moves.length} mouvement(s) de stock inverse(s) enregistré(s).`;
};

/** R-CPT-05: a validated entry is reversed, never changed. */
const reverseValidated: Compensation = async (tx, req, ctx, reason) => {
  const ids = ctx.changes
    .filter((c) => c.table === 'entry' && c.op === 'U' && c.new?.status === 'VALIDATED')
    .map((c) => str(c.key?.id));
  if (!ids.length) throw new Error('Aucune écriture validée à contre-passer.');
  for (const id of ids)
    await reverseEntry(tx, id, { userId: req.user!.id, label: `Contrepassation : ${reason}` });
  return `${ids.length} écriture(s) contre-passée(s).`;
};

const SALE_FROM_TILL = via(
  'Un ticket s’annule depuis la caisse (Tickets › Annuler) : l’annulation rend l’argent par le même moyen et passe dans la caisse du jour.',
  '/caisse/tickets',
);
const CANNOT_UNSEND = 'Ce qui a été envoyé ou téléchargé ne peut pas être repris.';
const CONNECTION = 'Une connexion est un fait, pas une modification.';

export const REVERT_POLICIES: Record<AuditAction, Resolver> = {
  // Accounting
  'account.create': restore,
  'account.update': restore,
  'account.delete': restore,
  'accounting.proposals': restore,
  'bank_account.create': restore,
  'bank_account.update': restore,
  'bank_line.match': restore,
  'bank_line.unmatch': restore,
  'bank_rule.create': restore,
  'bank_rule.update': restore,
  'bank_rule.delete': restore,
  'bank_statement.import': restore,
  'bank_statement.close': restore,
  'budget.save': restore,
  'deposit.create': restore,
  'entry.create': restore,
  'entry.update': restore,
  'entry.delete': restore,
  'entry.duplicate': restore,
  'entry.validate': {
    kind: 'compensate',
    label: 'Contre-passer les écritures validées',
    run: reverseValidated,
  },
  'entry.reverse': none(
    'Une contrepassation est définitive. Si elle était une erreur, saisissez à nouveau l’écriture d’origine.',
  ),
  'fiscal_year.create': restore,
  'fiscal_year.close': via(
    'Un exercice clôturé se rouvre depuis l’écran de clôture.',
    '/compta/cloture',
  ),
  'fiscal_year.reopen': via(
    'Un exercice rouvert se clôture depuis l’écran de clôture.',
    '/compta/cloture',
  ),
  'journal.create': restore,
  'journal.update': restore,
  'template.create': restore,
  'template.update': restore,
  'template.delete': restore,
  'report.save': restore,
  'report.delete': restore,
  // Till
  'device.create': restore,
  'session.open': restore,
  'session.close': via(
    'Une clôture se défait par « Rouvrir » sur la session (Administration › Caisse), tant que son écriture n’est pas validée.',
    '/admin/caisse',
  ),
  'session.join': none('Un poste qui rejoint la session ouverte n’a rien changé à la caisse.'),
  'session.reopen': via(
    'La session rouverte se clôture de nouveau depuis la caisse.',
    '/admin/caisse',
  ),
  'session.entry_failed': none('C’est un compte rendu d’erreur, pas une modification.'),
  'sale.create': SALE_FROM_TILL,
  'sale.cancel': none(
    'Une annulation de ticket est définitive (elle a rendu l’argent). Ressaisissez la vente si besoin.',
  ),
  'sale.email_sent': none(CANNOT_UNSEND),
  'sale.warnings_reviewed': restore,
  'sync.rejected': via(
    'Le ticket refusé n’a rien enregistré : faites-le ressaisir, puis classez-le dans Surveillance.',
    '/surveillance',
  ),
  'rejection.ack': restore,
  'wallet.topup': topup,
  'wallet.topup_cancel': none('Ressaisissez le versement depuis la fiche du foyer.'),
  'wallet.correction': {
    kind: 'compensate',
    label: 'Passer une correction de cagnotte du montant opposé',
    run: oppositeCorrection('de la correction'),
  },
  'wallet.overdraft_forced': none('C’est une autorisation donnée au moment de la vente.'),
  'wallet.history_sent': none(CANNOT_UNSEND),
  'membership.create': none(
    'Une adhésion payée ne s’efface pas : remboursez l’adhérent si besoin et prévenez la trésorerie, qui passera l’écriture.',
  ),
  'membership_type.update': restore,
  'preorder.create': restore,
  'preorder.status': restore,
  // Members
  'member.create': restore,
  'member.update': restore,
  'member.roles': restore,
  'member.qr_regenerate': none('L’ancien badge n’est pas conservé : régénérez-en un si besoin.'),
  'member.anonymize': none(
    'L’anonymisation est définitive (RGPD) : les données effacées ne sont plus nulle part.',
  ),
  'member.export': none(CANNOT_UNSEND),
  'household.update': restore,
  'password.link': none(CANNOT_UNSEND),
  'password.reset': none('Le mot de passe n’est pas conservé : envoyez un nouveau lien si besoin.'),
  'password.forgot': none(CANNOT_UNSEND),
  'auth.login': none(CONNECTION),
  'auth.logout': none(CONNECTION),
  'push.subscribe': restore,
  'push.unsubscribe': restore,
  'push.expired': none('L’appareil ne répondait plus.'),
  'favorite.add': restore,
  'favorite.remove': restore,
  'review.write': restore,
  'impersonate.start': none(CONNECTION),
  'impersonate.stop': none(CONNECTION),
  // Catalogue and supplies
  'product.create': restore,
  'product.update': restore,
  'product.status': restore,
  'product.image': none(
    'L’ancienne photo n’est pas conservée : remettez-la depuis la fiche du produit.',
  ),
  'product.bulk_prices': restore,
  'product.labels_done': restore,
  'category.create': restore,
  'category.update': restore,
  'universe.create': restore,
  'universe.update': restore,
  'supplier.create': restore,
  'supplier.update': restore,
  'order.create': restore,
  'order.update': restore,
  'order.send': restore,
  'order.close': restore,
  'order.cancel': restore,
  'order.delete': restore,
  'receipt.create': via(
    'Une réception a fait entrer du stock : corrigez-la depuis la commande (« Corriger la réception »).',
    '/appros/commandes',
  ),
  'receipt.correct': via(
    'Corrigez de nouveau la réception depuis la commande.',
    '/appros/commandes',
  ),
  'invoice.create': restore,
  'invoice.update': restore,
  'invoice.document': none('L’ancien document n’est pas conservé : joignez-le de nouveau.'),
  'invoice.pay': restore,
  'stock.loss': {
    kind: 'compensate',
    label: 'Enregistrer le mouvement de stock inverse',
    run: oppositeStock,
  },
  'stock.correction': {
    kind: 'compensate',
    label: 'Enregistrer le mouvement de stock inverse',
    run: oppositeStock,
  },
  'stock.batch.add': restore,
  'stock.batch.discard': (ctx) =>
    inserted(ctx, 'stock_movement').length
      ? { kind: 'compensate', label: 'Remettre le lot en stock', run: oppositeStock }
      : restore,
  'stock.batch.remove': restore,
  'inventory.open': restore,
  'inventory.count': restore,
  'inventory.validate': via(
    'Un inventaire validé a corrigé les stocks : corrigez les produits concernés depuis l’écran Stock.',
    '/appros/stock',
  ),
  'inventory.cancel': restore,
  'review.moderate': restore,
  // Administration
  'setting.update': restore,
  'integrity.accept': restore,
  'integrity.unaccept': restore,
  'integrity.fix': none(
    'Le recalcul a remis les chiffres en accord avec l’historique : il n’y a rien à défaire.',
  ),
  'import.apply': restore,
  'export.full': none(CANNOT_UNSEND),
  'export.file': none(CANNOT_UNSEND),
  'member.export_all': none(CANNOT_UNSEND),
  'wallet.report_export': none(CANNOT_UNSEND),
  'error.ack': restore,
  'email.resend': none(CANNOT_UNSEND),
  'staff.notified': none(CANNOT_UNSEND),
  'backup.report': none('C’est un compte rendu de sauvegarde.'),
  'audit.revert': restore,
};

export function policyFor(ctx: RevertContext): Policy {
  const r = (REVERT_POLICIES as Record<string, Resolver | undefined>)[ctx.entry.action];
  if (!r) return none('Action inconnue de cette version de l’application.');
  return typeof r === 'function' ? r(ctx) : r;
}
