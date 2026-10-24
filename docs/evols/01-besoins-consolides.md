# Besoins consolidés — migration vers EpiSoft-Web

Source : `Expression de besoins - migration.xlsx` (5 profils, préparation de la visio du samedi 10 octobre 17h).
État du code : audit du dépôt au 24/10/2026.

## Lecture

- **Niveau 1** : critique pour accepter la migration. **Niveau 2** : à garantir pour accepter la migration. **Niveau 3** : confort pour une migration sereine. « — » : non classé dans le classeur (traité comme niveau 3 par défaut, question Q7).
- **Vert** : acceptable pour la migration. **Orange** : bloquant, à corriger avant la migration.
- Le classeur annonce 9 sujets de niveau 1 (onglet Synthèse) ; le tableau ci-dessous en compte 9 (EV-T04, T05, C03, C07, A04, A05, A06, A12, A13).
- L'onglet « Équipe trésorerie » est vide ; seul EV-T05 (onglet « Profils prioritaires ») la concerne.

## Tableau

| ID | Profil | Auteur | Besoin | Niv. | État du code | Décision |
|---|---|---|---|---|---|---|
| EV-T01 | Transverse | Julie | Équipe « Maintenance et évolutions » : compétences requises pour rejoindre l'équipe admin (JP 15/10 : un développeur pro bono contacté) | 2 | — | Guide de maintenance (`docs/maintenance.md`) |
| EV-T02 | Transverse | Julie | Hébergement : conseil | 3 | spec §7.3, `docker/` | Note de recommandation |
| EV-T03 | Transverse | Ysé | Sécurité des données : garanties en place | 3 | spec §5.5-5.7 ; sauvegardes 14 dumps, sans copie externe | Documenter ; ajouter une copie externe |
| EV-T04 | Transverse | Julie | Cagnotte : fournir pour chaque adhérent le montant « exact » issu de l'enquête « cagnottes folles » | **1** | solde calculé (vue `household_balance`), contrôles CAG-01..03 ; comparaison avec `ADHSOLDE` à la migration | Rapport d'écart par foyer |
| EV-T05 | Trésorerie | Julie | Consolider juillet-août-septembre (clôture de juin fournie par Bruno) | **1** | clôture annuelle uniquement | Selon Q3 (exercice inconnu) |
| EV-T06 | Transverse | Renée | Conformité légale (RGPD) | 2 | FAIT | Aucune action |
| EV-T07 | Adhérents | Julie | Case « accepte l'utilisation de son image » (cf. bulletin d'adhésion) sur la fiche | 3 | absent | Ajouter |
| EV-C01 | Caissiers | Julie | Une session Epicafé Caisse, caissiers différents, fond de caisse unique, qui reste ouverte | 2 | session liée à un poste ; changement de caissier par badge | Session magasin, plusieurs postes (voir Q1) |
| EV-C02 | Caissiers | Julie | Menu déroulant à la saisie du produit (vigilance sur 250 g / 300 g) | 2 | liste seulement après Entrée, nom + prix | Autocomplétion avec conditionnement |
| EV-C03 | Caissiers | Julie | Imposer la saisie de l'adhérent avant de commencer le ticket | **1** | vente anonyme autorisée | Adhérent ou adhésion de passage obligatoire |
| EV-C04 | Caissiers | Julie | Bloquer l'encaissement tant que le mode de règlement n'est pas saisi (Cagnotte, Espèces, Chèque, CB) | 2 | bloqué jusqu'au règlement complet, mais Espèces présélectionné | Aucune présélection |
| EV-C05 | Caissiers | Julie | Niveau de cagnotte affiché dès l'adhérent sélectionné | 2 | FAIT | Vérifier, test e2e |
| EV-C06 | Caissiers | Renée | Proposer systématiquement une adhésion de passage si non adhérent ; montant de l'adhésion de passage modifiable par le caissier (demande ultérieure) | 3 | existe, montant fixé par le type d'adhésion | Intégré à EV-C03 ; montant modifiable (R-EVO-01) |
| EV-C07 | Caissiers | Renée | Clôture : validation par erreur au moment du comptage, impossible de revenir | **1** | pas de confirmation ; réouverture réservée à l'ADMIN | Confirmation + annulation |
| EV-C08 | Caissiers | Renée | Étiquettes rayon sans code-barres, pastille rouge (local) et verte (bio) | — | PDF d'étiquettes existe, code-barres toujours imprimé | Option + pastilles |
| EV-C09 | Caissiers | Demande ultérieure | Pouvoir enregistrer un don | — | le motif `DONATION` existe pour les paiements d'adhérent (compte 754000, produit legacy `01004`) ; pas de saisie de don dédiée à la caisse | Saisie de don en caisse (R-EVO-08) |
| EV-A01 | Resp. fournisseurs | Julie | Bon de commande identique à l'actuel | 3 | PDF existe | Comparer avec la v1 |
| EV-A02 | Resp. fournisseurs | Julie | Ouvrir la fenêtre mail (pro.epicafé) à la fin du bon de commande | 3 | envoi serveur existe ; pas de `mailto:` | Bouton `mailto:` |
| EV-A03 | Resp. fournisseurs | Julie | Depuis la caisse, modifier le bon de commande pour saisir le réellement livré, avec le nom du saisisseur (JP : la personne en caisse reporte ce que les abeilles constatent) | 3 | réception en back-office ; `received_by` stocké, invisible | Afficher + réception depuis la caisse |
| EV-A04 | Resp. fournisseurs | Julie | Inventaire : un inventaire juste à saisir (fermer l'épicerie une semaine si besoin) | **1** | inventaire existe, sans gel des ventes | Gel optionnel, feuilles de comptage |
| EV-A05 | Resp. fournisseurs | Renée, Benoit | Passage de commande : toutes les références du fournisseur, stock restant, colonne quantité commandée ; ajouter tous les produits | **1** | seulement les produits sous le stock minimum | Éditeur plein fournisseur |
| EV-A06 | Resp. fournisseurs | Renée | Réception : ajuster prix et quantités effectivement reçues | **1** | FAIT, non modifiable après validation | Vérifier ; Q4 |
| EV-A07 | Resp. fournisseurs | Renée | Effacer les commandes annulées | — | refusé par l'API | Autoriser |
| EV-A08 | Resp. fournisseurs | Renée | Stock : filtrer par fournisseur | — | absent | Ajouter |
| EV-A09 | Resp. fournisseurs | Renée, Benoit | Fournisseurs manquants (bocaux de l'Epte) ; contrôler la requête, les manquants, le stock positif | — | donnée à vérifier | Requête d'audit |
| EV-A10 | Factures | Julie | Saisie de facture : le menu ne propose pas les fournisseurs aux premières lettres | — | `<select>` simple | Combobox |
| EV-A11 | Factures | Julie, Dominique | Commande « cliquable » en popup avant de cocher | — | liste de numéros | Popup |
| EV-A12 | Factures | Julie | BUG : la TVA saisie disparaît à l'enregistrement | **1** | non reproduit à la lecture | Reproduire puis corriger |
| EV-A13 | Produit | Julie | BUG : création produit, tout renseigné, stock à zéro : « Une erreur inattendue est survenue » | **1** | erreur 500 ; cause à confirmer (journal API) | Diagnostic puis correctif |
| EV-A14 | Factures | Dominique | Export Excel des factures « à régler » et « réglées » | 3 | absent | Ajouter |
| EV-M01 | Adhérents clients | Julie | Ticket par courriel (solde avant, ticket, solde après) pour les adhérents en exclusion digitale | 2 | case par vente, sans soldes | Automatique avec soldes (décidé) |
| EV-M02 | Adhérents clients | Julie | À la connexion : état de la cagnotte (vert ou rouge), pas le cumul dépensé | 2 | marqué FAIT ; l'écran affiche un texte brut | Vérifier, badge vert/rouge |
| EV-M03 | Adhérents clients | Renée | Se connecter avec l'adresse courriel d'adhésion | — | identifiant seul | Identifiant ou courriel |
| EV-M04 | Adhérents clients | Renée | Historique d'activité incluant les règlements autres que cagnotte | — | tickets : total seul dans la vue adhérent | Modes de règlement affichés |

## Décisions déjà prises

- EV-C03 : adhérent ou adhésion de passage obligatoire ; le réglage `pos.sellToNonMembers` reste.
- EV-M01 : envoi automatique avec soldes avant/après, désinscription possible sur la fiche.
- EV-T05 : exercice comptable inconnu → défaut 1er juillet–30 juin, question ouverte Q3.
- EV-C01 : « plusieurs caissiers peuvent ouvrir des caisses, mais un seul tiroir (fond de caisse) et une seule clôture ».

## Questions ouvertes

| # | Question | Défaut appliqué |
|---|---|---|
| Q1 | EV-C01 : une session magasin, plusieurs postes simultanés, un seul tiroir ? | Oui |
| Q2 | EV-C03 : l'adhésion de passage est-elle encaissée systématiquement ? | Oui, comme aujourd'hui |
| Q3 | Exercice comptable : juillet–juin ou civil ? | Juillet–juin |
| Q4 | Corriger une réception après validation ? | Oui, par un responsable, avec contre-passation et audit |
| Q5 | Inventaire : gel des ventes pendant le comptage ? | Option, désactivée |
| Q6 | Un produit peut-il avoir plusieurs fournisseurs (un seul aujourd'hui) ? | Un seul |
| Q7 | Niveau des points non classés | 3 |
| Q8 | EV-C09 : un don peut-il être fait par un non-adhérent ? Un reçu fiscal est-il à émettre ? | Oui (donateur facultatif) ; pas de reçu fiscal pour l'instant |
