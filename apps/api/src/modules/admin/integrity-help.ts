/**
 * Plain-language explanation of every integrity check, shown on the Administration › Contrôles
 * page: what is compared, and what a person has to do when the check fails.
 */
export interface IntegrityHelp {
  /** What the check compares, and why the two sides must agree. */
  what: string;
  /** What to do when cases are listed. */
  todo: string;
}

export const INTEGRITY_HELP: Record<string, IntegrityHelp> = {
  'STK-01': {
    what: 'Le stock affiché pour un produit est mémorisé à part. Il doit être égal à la somme de tous ses mouvements (réceptions, ventes, pertes, corrections, inventaires). Le journal des mouvements est la référence.',
    todo: 'Cliquez sur « Recalculer le stock depuis les mouvements » : la valeur affichée est remise d’accord avec les mouvements. Si l’écart revient après coup, signalez-le à l’équipe technique, c’est un défaut de l’application.',
  },
  'STK-02': {
    what: 'Chaque ticket de la caisse doit avoir retiré du stock exactement les quantités vendues, une seule fois.',
    todo: 'Ouvrez le produit et regardez son historique de mouvements : un mouvement de vente manque ou est en double. Ajustez le stock par un inventaire, avec un motif. Si cela se reproduit, prévenez l’équipe technique. Il n’y a pas de bouton, car on ne sait pas laquelle des deux données est fausse.',
  },
  'STK-03': {
    what: 'Chaque réception de marchandises (livraison fournisseur) doit avoir ajouté au stock exactement les quantités reçues.',
    todo: 'Ouvrez le produit et comparez son historique à la réception concernée. Complétez ou corrigez le stock par un inventaire, avec un motif. Ne modifiez pas la réception : elle sert de pièce pour la facture et les prix d’achat.',
  },
  'STK-04': {
    what: 'Chaque ajustement d’un inventaire validé doit correspondre à un mouvement de stock identique.',
    todo: 'Ouvrez l’inventaire concerné. Un inventaire validé ne se modifie plus : refaites un inventaire des produits en cause. Prévenez l’équipe technique, ce cas ne doit pas se produire.',
  },
  'STK-05': {
    what: 'Aucun produit ne devrait avoir un stock négatif : cela signifie qu’il s’est vendu plus que ce qui a été enregistré en entrée.',
    todo: 'Cherchez la cause : une livraison reçue mais jamais enregistrée, ou un inventaire en retard. Enregistrez la réception manquante ou faites un inventaire. Si le cas est connu et que vous ne souhaitez pas le corriger tout de suite, utilisez « Accepter » avec une note.',
  },
  'CAG-01': {
    what: 'Ce qu’un ticket a été payé avec la cagnotte doit correspondre exactement aux opérations débitées (ou remboursées) sur la cagnotte du foyer.',
    todo: 'Ouvrez le foyer, comparez le ticket aux opérations de cagnotte, puis corrigez le solde par une « correction de cagnotte » du montant manquant ou en trop, avec un motif. Ne modifiez pas le ticket : il sert de pièce pour la caisse et la comptabilité. Prévenez l’équipe technique si le cas est récent.',
  },
  'CAG-02': {
    what: 'Chaque versement sur une cagnotte doit avoir une opération de cagnotte du même montant, et inversement.',
    todo: 'Ouvrez le foyer et regardez le versement et l’opération correspondante. Un versement saisi aujourd’hui peut être annulé puis ressaisi correctement ; sinon, passez une correction de cagnotte du montant de l’écart, avec un motif.',
  },
  'CAG-03': {
    what: 'Un foyer ne doit pas être en dessous du découvert autorisé, sauf si un responsable l’a explicitement forcé (cette décision est alors enregistrée).',
    todo: 'Contactez le foyer pour une recharge. Si le dépassement est voulu ou déjà réglé autrement, cliquez sur « Accepter » avec une note. Si le découvert autorisé est trop bas pour votre usage, ajustez-le dans les paramètres.',
  },
  'VTE-01': {
    what: 'Le total d’un ticket doit être égal à la somme de ses lignes, et chaque ligne doit être bien calculée (quantité × prix − remise).',
    todo: 'Ouvrez le foyer, retrouvez le ticket et vérifiez ses lignes. Un ticket ne se modifie pas : s’il est faux, annulez-le (ce qui crée un ticket opposé) puis ressaisissez la vente. Prévenez l’équipe technique, ce cas ne doit pas se produire.',
  },
  'VTE-02': {
    what: 'Les paiements d’un ticket (espèces, carte, cagnotte, etc.) doivent totaliser exactement son montant.',
    todo: 'Ouvrez le foyer et retrouvez le ticket. Un ticket ne se modifie pas : annulez-le puis ressaisissez la vente avec les bons paiements. Prévenez l’équipe technique, ce cas ne doit pas se produire.',
  },
  'VTE-03': {
    what: 'Un ticket d’annulation doit être exactement l’opposé du ticket annulé, et le ticket annulé doit être marqué comme annulé.',
    todo: 'Ouvrez le foyer et regardez les deux tickets. Faites remonter le cas à l’équipe technique : l’annulation est une opération comptable qu’on ne corrige pas à la main.',
  },
  'VTE-04': {
    what: 'La remise totale d’un ticket doit être la somme des remises de ses lignes.',
    todo: 'Cliquez sur « Recalculer la remise totale des tickets » : elle est recalculée à partir des lignes. Aucune autre vérification n’est nécessaire, l’argent encaissé n’est pas concerné.',
  },
  'VTE-05': {
    what: 'Pour les tickets repris de l’ancienne application, le total encaissé devrait être égal à la somme des lignes. L’ancienne base elle-même contient ces écarts (lignes différentes du total, parfois aucune ligne).',
    todo: 'Aucune correction n’est possible ni nécessaire : le total encaissé est le bon, seul le détail par produit est inexact pour ces tickets, ce qui ne touche que les statistiques de ventes par produit. Utilisez « Accepter » avec une note du type « ancienne application ».',
  },
  'CPT-01': {
    what: 'Une écriture comptable validée doit être équilibrée (total des débits = total des crédits) et comporter au moins deux lignes.',
    todo: 'Ouvrez l’écriture. Une écriture validée est verrouillée : passez une écriture inverse (extourne) qui l’annule, puis saisissez la bonne écriture. Prévenez l’équipe technique, ce cas ne doit pas se produire.',
  },
  'CPT-02': {
    what: 'Un brouillon d’écriture déséquilibré ne pourra pas être validé : débits et crédits doivent être égaux.',
    todo: 'Ouvrez le brouillon, corrigez les montants ou ajoutez la ligne manquante, puis validez-le. Si le brouillon est inutile, supprimez-le.',
  },
  'CPT-03': {
    what: 'Le compte 411000 de la comptabilité représente ce que l’association doit aux adhérents : il doit être égal au total des cagnottes de tous les foyers.',
    todo: 'Ouvrez les éditions comptables, regardez le compte 411000 et comparez-le au total des cagnottes. Cherchez les versements non comptabilisés ou les écritures de reprise manquantes, et passez une écriture de régularisation décidée avec le trésorier. Si l’écart est connu (reprise de l’ancienne comptabilité), « Accepter » avec une note.',
  },
  'FAC-01': {
    what: 'Pour une facture fournisseur, le montant TTC doit être égal au montant HT plus la TVA.',
    todo: 'Ouvrez la facture, comparez-la à la pièce papier et corrigez le montant erroné. Si son écriture comptable est déjà validée, il faut d’abord l’extourner.',
  },
  'SYN-01': {
    what: 'Un poste de caisse a envoyé un ticket (ou un versement) que le serveur a refusé : il n’a donc modifié ni le stock ni la cagnotte.',
    todo: 'Ouvrez Surveillance › Tickets à vérifier : lisez le motif, faites ressaisir le ticket à la caisse (bouton « Ressaisir ce ticket » dans « Tickets du jour ») si la vente a bien eu lieu, puis classez le refus.',
  },
  'SES-01': {
    what: 'Une session de caisse est ouverte depuis plus de 24 heures : elle a sans doute été oubliée à la fermeture.',
    todo: 'Clôturez-la depuis la caisse concernée. Si le poste est perdu, un administrateur peut la clôturer dans Administration › Caisse, avec un motif.',
  },
  'SES-02': {
    what: 'Les espèces attendues, calculées au moment de la clôture, doivent être égales au fond de caisse plus les ventes et encaissements en espèces de la session. Un écart signifie qu’un ticket est arrivé après la clôture ou qu’un montant a été modifié.',
    todo: 'Ouvrez la session dans Administration › Caisse et regardez les tickets reçus après la clôture. Si tout est expliqué, acceptez le point avec une note.',
  },
  'VTE-06': {
    what: 'Ces tickets sont bien enregistrés, mais la caisse ou le serveur a signalé quelque chose d’inhabituel (prix très différent, quantité élevée, remise forte, stock négatif, horloge du poste).',
    todo: 'Ouvrez Surveillance › Tickets à vérifier, lisez l’avertissement, corrigez ce qui doit l’être (prix du catalogue, inventaire), puis cliquez « Vu ».',
  },
  'FAC-02': {
    what: 'Le total d’une facture fournisseur doit être proche du total des réceptions qu’elle couvre (à un euro près, pour les arrondis).',
    todo: 'Ouvrez la facture : comparez les quantités et les prix reçus avec ceux de la facture, demandez un avoir ou une facture rectificative au fournisseur, ou corrigez la réception si la saisie était fausse.',
  },
  'MEM-01': {
    what: 'Deux fiches portent le même nom et le même prénom : il s’agit probablement de la même personne, enregistrée deux fois.',
    todo: 'Ouvrez les deux fiches. Si c’est la même personne, gardez celle qui a l’historique et archivez l’autre. Si ce sont deux personnes différentes (homonymes), acceptez le point avec une note.',
  },
  'CAG-05': {
    what: 'Chaque matin l’application note le solde de chaque cagnotte. Le solde actuel doit être égal à ce solde plus les mouvements enregistrés depuis. Un écart veut dire qu’un mouvement ancien a été ajouté, modifié ou supprimé sans passer par une opération normale.',
    todo: 'Ouvrez le foyer et regardez son historique depuis la date indiquée. Rétablissez la cagnotte par une correction avec un motif, et prévenez l’équipe technique : cela ne devrait jamais arriver.',
  },
  'REF-01': {
    what: 'Des lignes pointent vers un élément qui n’existe plus (par exemple des ventes rattachées à un poste de caisse supprimé). La base l’interdit normalement : cela n’arrive qu’après un chargement ou une réparation faits à la main. Une base dans cet état ne se restaure pas proprement depuis sa propre sauvegarde.',
    todo: 'Prévenez l’équipe technique sans attendre, avec la liste affichée. Ne supprimez rien : il faut recréer l’élément manquant (ou rattacher les lignes au bon élément), puis vérifier qu’une sauvegarde se restaure.',
  },
  'MAIL-01': {
    what: 'Des courriels n’ont pas pu partir ces 7 derniers jours (adresse invalide, messagerie en panne).',
    todo: 'Ouvrez Surveillance › Courriels : vérifiez l’adresse, puis renvoyez. Si tous échouent, le réglage de la messagerie est à vérifier.',
  },
  'BKP-01': {
    what: 'La sauvegarde automatique de la base doit tourner chaque nuit et le dire à l’application. Aucune sauvegarde récente n’a été signalée.',
    todo: 'Regardez Surveillance › Sauvegardes et le guide de maintenance : la tâche planifiée du serveur s’est peut-être arrêtée. Faites une sauvegarde à la main en attendant.',
  },
  'PRE-01': {
    what: 'Une précommande marquée « retirée » doit être liée au ticket de caisse sur lequel elle a été réglée.',
    todo: 'Ouvrez la liste des précommandes, retrouvez la commande et vérifiez le ticket de caisse du retrait. Si la commande n’a pas été retirée, remettez-la à son état d’origine. Si le ticket existe, signalez-le à l’équipe technique pour le relier. Sinon, « Accepter » avec une note.',
  },
};

export const FALLBACK_HELP: IntegrityHelp = {
  what: 'Contrôle automatique de cohérence entre deux sources de données.',
  todo: 'Ouvrez les éléments listés pour les examiner.',
};
