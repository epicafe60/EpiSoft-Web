# Décisions de l'équipe de l'Épicafé

Réponses de l'équipe (transmises par la responsable du projet) aux questions ouvertes, le 15 novembre 2026. Elles guident ce qu'on construit, et surtout ce qu'on **ne construit pas**.

## Principe

L'outil ne cherche pas à anticiper tous les scénarios. La boutique a ouvert le 14 février 2026 : l'équipe de bénévoles est petite, et elle veut garder de la vigilance humaine à l'usage. On ne code pas de brique pour des usages ou des personnes qui n'existent pas encore. Avant d'ajouter un calcul automatique, un avertissement, un contrôle ou un module, on vérifie que l'équipe l'a demandé.

> **Mise à jour du 15 novembre 2026 (propriétaire du projet) : la décision « Prix d'achat et TVA : saisis, jamais calculés » ci-dessous est REMPLACÉE** pour des raisons de conformité (TVA, plan comptable, loi anti-fraude TVA). Désormais, c'est le serveur qui garantit la cohérence : une TVA de fiche produit doit valoir PA HT × taux (à 1 centime près) ; une facture fournisseur est ventilée par taux (0, 2,1, 5,5, 10, 20 %), son HT, sa TVA et son TTC sont des sommes calculées, et une ligne dont la TVA s'écarte de plus de 2 centimes de HT × taux est refusée avec un message clair ; la TVA incluse dans un ticket est calculée par taux (jamais ligne par ligne). Le régime de TVA (assujetti, franchise en base art. 293 B, exonéré art. 261) est un paramètre daté, voir l'ADR 0016. Le reste du document (réception, modules à ne pas construire, consommation interne) reste valable.

## Décisions

### Prix d'achat et TVA : saisis, jamais calculés (REMPLACÉ le 15 novembre 2026, voir ci-dessus et ADR 0016)

- **Fiche produit** : le PA HT, le montant de TVA (en €) et le PA TTC sont trois champs libres. L'outil ne les calcule pas et n'en recalcule aucun quand on en modifie un autre. (Le logiciel précédent avait une boucle de bug à cet endroit.) Si une suggestion de calcul existe un jour, la personne doit pouvoir l'écraser.
- **Saisie d'une facture fournisseur** : montant total HT, montant de la TVA et montant total TTC, en €, sont trois champs libres. Un même fournisseur facture plusieurs taux de TVA (5,5 %, 20 %…) sur une même facture : le détail par taux n'est pas saisi.
- **Pas d'avertissement ni de blocage** en cas d'écart d'arrondi entre HT, TVA et TTC.
- **Pas de case « remise »** sur la facture pour l'instant : à rediscuter après une année de gestion comptable par la nouvelle équipe.
- **Fournisseur payé « à réception fin de mois »** : case sur la fiche fournisseur ; la facture est alors à payer à la fin du mois où elle est saisie (le rappel « à payer » apparaît à ce moment).

### Réception d'une commande

Le prix d'achat de la fiche produit **n'est pas mis à jour automatiquement** à la réception : la vigilance des bénévoles est voulue, et une alerte de la machine la ferait baisser.

**Précisé le 2026-11-15 par le propriétaire**, à la manière des outils du marché (Odoo, Dolibarr, Zoho) :

- Modifier le prix unitaire dans une commande ne change que la ligne de commande (celle qui est imprimée) : jamais la fiche produit.
- L'écran de réception montre, par ligne, le prix de la fiche, le prix commandé et le prix reçu, et met l'écart en évidence (montant et %). Une case « Mettre à jour la fiche produit », **décochée par défaut**, met la fiche à jour (HT, TVA et TTC cohérents avec le taux du produit) ; sans case cochée la fiche n'est pas touchée. Le serveur applique la même règle.
- Le coût réel reste toujours sur la ligne de réception et sur le mouvement de stock, quelle que soit la case.
- L'écran affiche l'effet du nouveau prix d'achat sur la marge.

### À ne pas construire pour l'instant

- Import de PDF (factures, relevés), gabarits par fournisseur, validation avant enregistrement.
- Lecture de documents par une IA : **non**, tout reste sur le serveur, en attendant que l'équipe sache reconstituer son premier bilan de clôture.
- Module de frais de fonctionnement, classement automatique des opérations bancaires à l'import d'un relevé, notes de frais, répartition de TVA par taux sur les frais.
- Traitement comptable de la consommation interne.
- Les factures fournisseur sont chargées **par des personnes**, c'est leur travail.

Toute réflexion sur le module comptable (TVA récupérable, comptes, répartition par taux) attend que la nouvelle équipe comptable existe : on ne la devine pas à sa place.

### Consommation interne (café, jus de pomme des caissiers)

Elle se faisait par une vente sur l'adhérent « Epicafé Épicerie ». Un motif « consommation interne » avec un total mensuel dans les statistiques est acceptable s'il est simple ; sinon on laisse tel quel.

### À conserver

Distinguer les frais des achats de marchandises dans les statistiques et les exports : oui, évidemment.
