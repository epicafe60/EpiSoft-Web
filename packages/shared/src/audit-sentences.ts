// What the audit journal says, in a sentence a volunteer can read (Surveillance › Derniers
// changements). The journal itself keeps the raw action and the before/after for the technical
// team; this is the plain-language layer. `audit()` only accepts the actions listed here.

type After = Record<string, unknown> | null | undefined;

const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const named = (a: After, ...keys: string[]) => {
  for (const k of keys) {
    const v = a?.[k];
    if (typeof v === 'string' && v) return ` « ${v} »`;
  }
  return '';
};

export const AUDIT_SENTENCES = {
  // Accounting
  'account.create': (a) => `a créé un compte comptable${named(a, 'number', 'label')}`,
  'account.update': (a) => `a modifié un compte comptable${named(a, 'number', 'label')}`,
  'account.delete': () => 'a supprimé un compte comptable',
  'accounting.proposals': () => 'a généré des propositions d’écritures',
  'bank_account.create': () => 'a ajouté un compte bancaire',
  'bank_account.update': () => 'a modifié un compte bancaire',
  'bank_line.match': () => 'a rapproché une ligne bancaire',
  'bank_line.unmatch': () => 'a défait un rapprochement bancaire',
  'bank_rule.create': () => 'a créé une règle d’affectation bancaire',
  'bank_rule.update': () => 'a modifié une règle d’affectation bancaire',
  'bank_rule.delete': () => 'a supprimé une règle d’affectation bancaire',
  'bank_statement.import': () => 'a importé un relevé bancaire',
  'bank_statement.close': () => 'a clôturé un relevé bancaire',
  'budget.save': () => 'a enregistré le budget',
  'deposit.create': () => 'a enregistré une remise en banque',
  'entry.create': () => 'a saisi une écriture comptable',
  'entry.update': () => 'a modifié une écriture comptable',
  'entry.delete': () => 'a supprimé une écriture en brouillon',
  'entry.duplicate': () => 'a dupliqué une écriture comptable',
  'entry.validate': () => 'a validé des écritures comptables',
  'entry.reverse': () => 'a contre-passé une écriture comptable',
  'fiscal_year.create': () => 'a créé un exercice comptable',
  'fiscal_year.close': () => 'a clôturé un exercice comptable',
  'fiscal_year.reopen': () => 'a rouvert un exercice comptable',
  'journal.create': () => 'a créé un journal comptable',
  'journal.update': () => 'a modifié un journal comptable',
  'template.create': () => 'a créé un guide de saisie',
  'template.update': () => 'a modifié un guide de saisie',
  'template.delete': () => 'a supprimé un guide de saisie',
  'report.save': () => 'a enregistré un rapport',
  'report.delete': () => 'a supprimé un rapport',
  // Till
  'device.create': (a) => `a déclaré un poste de caisse${named(a, 'name')}`,
  'session.open': () => 'a ouvert une session de caisse',
  'session.join': () => 'a rejoint la session de caisse déjà ouverte',
  'session.close': (a) =>
    a?.forced && typeof a.comment === 'string' && a.comment.startsWith('Clôture administrative')
      ? 'a clôturé d’office une session de caisse'
      : 'a clôturé une session de caisse',
  'session.regularize': () =>
    'a régularisé une clôture de caisse après des tickets arrivés en retard',
  'session.reopen': () => 'a rouvert une session de caisse clôturée',
  'session.entry_failed': () => 'La clôture de caisse n’a pas pu générer son écriture comptable',
  'sale.create': (a) =>
    `a encaissé un ticket${named(a, 'number')}${a?.total ? ` de ${s(a.total)} €` : ''}`,
  'sale.cancel': (a) => `a annulé un ticket${named(a, 'number')}`,
  'sale.email_sent': (a) => `a envoyé un ticket par courriel${named(a, 'number')}`,
  'sale.warnings_reviewed': (a) => `a examiné les avertissements d’un ticket${named(a, 'number')}`,
  'sync.rejected': (a) =>
    `Un envoi de la caisse a été refusé par le serveur${typeof a?.reason === 'string' ? ` : ${a.reason}` : ''}`,
  'rejection.ack': () => 'a classé un ticket refusé par le serveur',
  'wallet.topup': (a) =>
    `a enregistré un versement sur une cagnotte${a?.amount ? ` de ${s(a.amount)} €` : ''}`,
  'wallet.topup_cancel': () => 'a annulé un versement de cagnotte',
  'wallet.correction': (a) => `a corrigé une cagnotte${a?.amount ? ` de ${s(a.amount)} €` : ''}`,
  'wallet.overdraft_forced': () => 'a autorisé un découvert de cagnotte',
  'wallet.history_sent': () => 'a envoyé l’historique de cagnotte à un foyer',
  'membership.create': () => 'a enregistré une adhésion',
  'membership_type.update': () => 'a modifié un type d’adhésion',
  'preorder.create': () => 'a passé une précommande',
  'preorder.status': () => 'a changé l’état d’une précommande',
  // Members
  'member.create': (a) => `a créé une fiche adhérent${named(a, 'lastName')}`,
  'member.update': () => 'a modifié une fiche adhérent',
  'member.roles': () => 'a modifié les rôles d’un utilisateur',
  'member.qr_regenerate': () => 'a régénéré le badge d’un adhérent',
  'member.anonymize': () => 'a anonymisé et archivé un adhérent',
  'member.export': () => 'a exporté les données d’un adhérent',
  'household.update': () => 'a modifié un foyer',
  'password.link': () => 'a envoyé un lien de mot de passe',
  'password.reset': () => 'a changé son mot de passe',
  'password.forgot': () => 'a demandé un lien « mot de passe oublié »',
  'auth.login': () => 's’est connecté',
  'auth.logout': () => 's’est déconnecté',
  'push.subscribe': () => 'a activé les notifications sur un appareil',
  'push.unsubscribe': () => 'a désactivé les notifications sur un appareil',
  'favorite.add': () => 'a ajouté un produit à ses favoris',
  'favorite.remove': () => 'a retiré un produit de ses favoris',
  'review.write': () => 'a donné son avis sur un produit',
  'impersonate.start': () => 'a pris la place d’un utilisateur (aide à distance)',
  'impersonate.stop': () => 'a repris sa propre place',
  // R-SES-07: the cashier keeping the till
  'till.cashier': () => 'a pris la caisse',
  'till.unlock': () => 'a repris la caisse et son compte (mot de passe retapé)',
  'member.till_pin': () => 'a choisi son code caissier',
  'member.till_pin_clear': () => 'a effacé le code caissier d’un bénévole',
  // Catalogue and supplies
  'product.create': (a) => `a créé un produit${named(a, 'name')}`,
  'product.update': (a) => `a modifié un produit${named(a, 'name')}`,
  'product.status': (a) =>
    a?.status === 'ARCHIVED' ? 'a archivé un produit' : 'a changé l’état d’un produit',
  'product.image': () => 'a changé la photo d’un produit',
  'product.bulk_prices': () => 'a modifié des prix en masse',
  'product.labels_done': () => 'a marqué des étiquettes comme imprimées',
  'category.create': () => 'a créé un rayon',
  'category.update': () => 'a modifié un rayon',
  'universe.create': () => 'a créé un univers',
  'universe.update': () => 'a modifié un univers',
  'supplier.create': (a) => `a créé un fournisseur${named(a, 'name')}`,
  'supplier.update': () => 'a modifié un fournisseur',
  'order.create': (a) => `a créé une commande fournisseur${named(a, 'number')}`,
  'order.update': () => 'a modifié une commande fournisseur',
  'order.send': () => 'a envoyé une commande au fournisseur',
  'order.close': () => 'a soldé une commande fournisseur',
  'order.cancel': () => 'a annulé une commande fournisseur',
  'order.delete': () => 'a supprimé une commande fournisseur',
  'receipt.create': (a) => `a enregistré une réception${named(a, 'receipt')}`,
  'receipt.correct': (a) => `a corrigé une réception${named(a, 'number')}`,
  'invoice.create': () => 'a saisi une facture fournisseur',
  'invoice.update': () => 'a modifié une facture fournisseur',
  'invoice.document': () => 'a joint le document d’une facture',
  'invoice.pay': () => 'a enregistré le paiement d’une facture fournisseur',
  'stock.loss': () => 'a déclaré une perte de stock',
  'stock.correction': () => 'a corrigé un stock',
  'stock.batch.add': () => 'a ajouté une date limite de stock',
  'stock.batch.discard': () => 'a jeté un lot arrivé à date limite',
  'stock.batch.remove': () => 'a retiré une date limite de stock',
  'inventory.open': (a) => `a ouvert un inventaire${named(a, 'label')}`,
  'inventory.count': (a) => `a saisi un comptage d’inventaire${named(a, 'product')}`,
  'inventory.validate': () => 'a validé un inventaire',
  'inventory.cancel': () => 'a annulé un inventaire',
  'review.moderate': () => 'a modéré un avis client',
  // Administration
  'setting.update': (a) => `a modifié un réglage${named(a, 'key')}`,
  'integrity.accept': () => 'a accepté un point des contrôles de cohérence',
  'integrity.unaccept': () => 'a rouvert un point des contrôles de cohérence',
  'integrity.fix': () => 'a recalculé des chiffres depuis les contrôles de cohérence',
  'import.apply': () => 'a importé un fichier',
  'export.full': () => 'a exporté toute la base',
  'member.export_all': () => 'a exporté la liste des adhérents',
  'wallet.report_export': () => 'a exporté le rapport des cagnottes',
  'error.ack': (a) => `a classé une erreur du serveur${named(a, 'ref')}`,
  'staff.notified': (a) => `Message envoyé aux responsables${named(a, 'subject')}`,
  'push.expired': () => 'Notifications retirées d’un appareil qui ne répond plus',
  'email.view': (a) => `a consulté un courriel${named(a, 'subject')}`,
  'email.resend': () => 'a renvoyé un courriel non parti',
  'export.file': (a) => `a téléchargé un fichier${named(a, 'file')}`,
  'backup.report': (a) =>
    a?.kind === 'RESTORE_TEST'
      ? `Test de restauration ${a?.ok ? 'réussi' : 'en échec'}`
      : `Sauvegarde ${a?.ok ? 'réussie' : 'en échec'}`,
  'audit.revert': (a) =>
    `a annulé une action du journal${typeof a?.reason === 'string' && a.reason ? ` (motif : ${a.reason})` : ''}`,
} satisfies Record<string, (after: After) => string>;

/** Every action the journal can record. */
export type AuditAction = keyof typeof AUDIT_SENTENCES;
export const AUDIT_ACTIONS = Object.keys(AUDIT_SENTENCES) as AuditAction[];

/** The sentence for an audited action (a readable fallback when the action is not known). */
export function describeAudit(action: string, after?: unknown): string {
  const f = (AUDIT_SENTENCES as Record<string, (after: After) => string>)[action];
  if (f) return f(after && typeof after === 'object' ? (after as After) : null);
  return `a effectué l’action « ${action.replace(/[._]/g, ' ')} »`;
}
