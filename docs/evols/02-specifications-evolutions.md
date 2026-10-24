# Spécifications des évolutions de migration

Complète `docs/specifications.md`. Chaque règle `R-EVO-nn` renvoie à un besoin de `01-besoins-consolides.md` et aux règles existantes qu'elle modifie. Vocabulaire métier en français, identifiants de code en anglais.

## 1. Caisse

**R-EVO-01 — Adhérent obligatoire (EV-C03, EV-C06). Modifie R-VTE.**
- Avant d'ajouter la première ligne, le caissier choisit un adhérent ou lance l'adhésion de passage. Tant que ce n'est pas fait, la saisie d'articles est bloquée et un message explique pourquoi.
- Si le ticket n'a pas d'adhérent et que l'adhésion de passage est possible, elle est proposée à chaque ticket.
- Le réglage `pos.sellToNonMembers` désactivé rétablit la vente anonyme.
- Le montant de l'adhésion de passage est modifiable par le caissier au moment de l'ajout. Le montant proposé est le prix du type d'adhésion `PASSING` ; le montant saisi doit être positif ou nul (≥ 0, deux décimales) et s'applique à la ligne d'adhésion du ticket uniquement, sans changer le tarif du type d'adhésion. Le montant d'origine et le montant saisi sont conservés sur la ligne (audit) ; la saisie d'un montant différent est tracée avec le caissier.
- Fonctionne hors ligne (règle pure dans `packages/shared/src/pos.ts`).
- *Critères* : sans adhérent, ajouter un article est impossible ; avec l'adhésion de passage, le ticket contient la ligne d'adhésion au montant proposé, modifiable ; un montant de 3 € à la place de 5 € est encaissé, le tarif du type reste à 5 € et l'écart est visible dans le journal ; un montant négatif est refusé ; réglage coupé, la vente anonyme fonctionne.

**R-EVO-02 — Mode de règlement explicite (EV-C04).**
- Aucun mode n'est présélectionné. « Valider le ticket » reste désactivé tant qu'aucun mode (Cagnotte, Espèces, Chèque, CB) n'est coché et que le total n'est pas couvert.
- *Critère* : à l'ouverture de l'écran de paiement aucun mode n'est actif et la validation est impossible.

**R-EVO-03 — Recherche avec liste déroulante (EV-C02).**
- La liste s'affiche dès 2 caractères, sur le nom, le code et le code-barres (20 résultats maximum).
- Chaque ligne montre le nom, le conditionnement (`unitQty` : 250 g, 300 g…), le prix et le stock si connu. Deux produits de même nom se distinguent par ce conditionnement.
- Fonctionne hors ligne à partir du snapshot local ; navigation au clavier.
- *Critère* : deux produits « Lentilles 250 g » et « Lentilles 300 g » apparaissent séparément, identifiables, avant toute sélection.

**R-EVO-04 — Cagnotte visible (EV-C05).**
- Dès la sélection de l'adhérent, le solde s'affiche en grand, coloré (vert si suffisant pour le ticket en cours, rouge sinon). Comportement existant, ajouté aux tests e2e.

**R-EVO-05 — Clôture sécurisée (EV-C07). Modifie R-CLO.**
- Avant la validation, une fenêtre récapitule : espèces comptées, attendu, écart, dépôt en banque, fond suivant. Elle demande une confirmation explicite ; « Corriger » revient au comptage sans rien enregistrer.
- Après la clôture, un responsable (droit de clôture de caisse, plus seulement l'ADMIN) peut l'annuler tant que l'écriture comptable n'est pas validée. L'annulation est journalisée.
- *Critères* : le récapitulatif s'affiche avant tout enregistrement ; une clôture annulée rouvre la session avec ses tickets ; refus si l'écriture est validée.

**R-EVO-06 — Session magasin à plusieurs postes (EV-C01). Modifie R-SES. À confirmer (Q1).**
- Une seule session est ouverte à la fois pour le magasin, avec un seul fond de caisse. Plusieurs postes peuvent s'y rattacher en même temps.
- Chaque ticket garde son caissier ; la clôture compte un seul tiroir et affiche des sous-totaux par caissier et par poste.
- La session reste ouverte quand on change de caissier ; le changement par liste et PIN s'ajoute au badge.
- Les postes hors ligne se synchronisent sur la session commune (protocole spec §8.3).
- *Critères* : deux postes vendent dans la même session ; une seule clôture ; le rapport donne le total par caissier.

**R-EVO-07 — Étiquettes de rayon (EV-C08).**
- Option « sans code-barres » pour une planche d'étiquettes.
- Pastille rouge pour les produits de qualité LOCAL, verte pour ORGANIC ; les deux si le produit cumule.
- *Critère* : une étiquette locale et bio sans code-barres affiche deux pastilles et aucun code.

**R-EVO-08 — Enregistrer un don (EV-C09). Voir Q8.**
- Depuis la caisse, une action « Don » permet de saisir un montant (> 0, deux décimales), un mode de règlement (Espèces, Chèque, CB ; la cagnotte est exclue) et, facultativement, le donateur (adhérent). Un don sans adhérent est accepté (Q8).
- Le don est un paiement hors vente de motif `DONATION` (`member_payment`), rattaché à la session de caisse et au caissier. Il s'ajoute aux encaissements hors ventes de la clôture (espèces attendues si Espèces) et est comptabilisé en 754000 « Dons » (écriture de clôture existante).
- Le don peut aussi être ajouté en ligne dans un ticket (« arrondir / ajouter un don ») ; dans ce cas il suit le règlement du ticket.
- Le don figure dans l'historique de l'adhérent et dans les exports ; il est annulable par un responsable (contre-passation, journalisé). Il fonctionne hors ligne (opération synchronisée comme les recharges).
- Le courriel de confirmation de l'adhérent (R-EVO-40) mentionne le don s'il y a une adresse.
- *Critères* : un don de 10 € en espèces augmente les espèces attendues de 10 € à la clôture et crée une ligne 754000 de 10 € ; un don par CB n'augmente pas les espèces ; un don sans adhérent est enregistré ; un montant nul ou négatif est refusé.

## 2. Approvisionnement

**R-EVO-10 — Commande sur toutes les références (EV-A05). Modifie R-CMD.**
- L'éditeur d'un bon de commande liste toutes les références actives du fournisseur, avec stock actuel, stock minimum, quantité suggérée et une colonne « Qté commandée » éditable.
- Le bouton « Ajouter tous les produits » complète le brouillon ; les lignes à zéro ne sont pas enregistrées.
- Les précommandes ouvertes (R-PRE-02) restent comptées dans la suggestion.
- *Critère* : un produit sans stock minimum apparaît et peut être commandé.

**R-EVO-11 — Réception (EV-A06, EV-A03). Modifie R-REC. Voir Q4.**
- Prix et quantités reçues sont modifiables ; la fiche de réception montre « saisi par » (utilisateur) et la date.
- Une réception validée est corrigeable par un responsable : contre-passation du stock, nouvelle réception, trace d'audit.
- La réception peut aussi se faire depuis la caisse (en ligne), avec le caissier courant comme auteur.

**R-EVO-12 — Suppression des commandes annulées (EV-A07).** Une commande ANNULÉE (sans réception) peut être supprimée ; une commande avec réception ne peut pas l'être.

**R-EVO-13 — Filtre fournisseur (EV-A08).** Le catalogue et l'écran de stock se filtrent par fournisseur (`supplierId`), cumulable avec les filtres existants.

**R-EVO-14 — Bon de commande et courriel (EV-A01, EV-A02).**
- Le PDF reprend la mise en page du bon de commande de la v1 (comparaison sur un exemple réel avant clôture du point).
- Un bouton « Ouvrir dans ma messagerie » génère un lien `mailto:` (destinataire, objet et corps préremplis) ; le PDF est téléchargé pour être joint. L'envoi serveur reste disponible.

**R-EVO-15 — Données fournisseurs (EV-A09).** Un rapport de migration liste les produits sans fournisseur, les fournisseurs sans produit et les produits à stock positif dont le fournisseur manque. Un produit garde un seul fournisseur (Q6).

## 3. Factures fournisseurs

**R-EVO-20 — Saisie de facture (EV-A10, EV-A11, EV-A12).**
- Le champ fournisseur est une liste filtrable par les premières lettres.
- Cliquer sur une réception ouvre une fenêtre avec ses lignes avant de la cocher.
- La TVA saisie est conservée à l'enregistrement et réaffichée (HT, TVA, TTC dans la liste et le détail).
- *Critère* : saisir 5,50 € de TVA, enregistrer, rouvrir : 5,50 € s'affiche (test e2e).

**R-EVO-21 — Export des factures (EV-A14).** Export Excel des factures « à régler », « réglées » ou toutes, avec fournisseur, dates, HT, TVA, TTC, statut de règlement.

**R-EVO-22 — Création de produit (EV-A13).** La création avec tous les champs et un stock à zéro réussit ; toute erreur serveur renvoie un message exploitable (champ en cause) et une référence de journal. Test API de non-régression.

## 4. Inventaire

**R-EVO-30 — Inventaire prêt à saisir (EV-A04). Modifie R-INV.**
- Contrôle préalable : stocks négatifs, produits sans fournisseur, produits actifs sans stock connu.
- Feuilles de comptage PDF/Excel, triées par rayon ou fournisseur.
- Option « geler les ventes » pendant l'inventaire (désactivée par défaut, Q5) ; sinon le calcul actuel compense les ventes faites depuis le comptage.
- *Critère* : gel actif, la caisse refuse une vente avec un message clair ; gel levé à la validation ou à l'annulation.

## 5. Adhérents, cagnotte et courriels

**R-EVO-40 — Ticket par courriel (EV-M01). Modifie R-COU.**
- Après chaque vente ou recharge, un courriel est envoyé à l'adhérent s'il a une adresse et n'a pas coché « ne plus recevoir mes tickets ».
- Contenu : solde avant, ticket, solde après.
- Le réglage `email.enabled` coupe tous les envois. Une anomalie d'envoi ne bloque jamais la vente.
- Colonne `member.ticketEmailOptOut` (booléen) modifiable par l'adhérent et le back-office.
- *Critères* : vente à 12 € avec solde 30 € → courriel « avant 30,00 €, après 18,00 € » ; adhérent désinscrit ou sans courriel → aucun envoi.

**R-EVO-41 — État de la cagnotte à la connexion (EV-M02).** « Mon foyer » affiche en premier l'état de la cagnotte (vert, rouge si solde négatif ou nul) avec le montant ; le cumul dépensé passe en second plan.

**R-EVO-42 — Connexion par courriel (EV-M03).** Le champ de connexion accepte l'identifiant ou le courriel d'adhésion (unique, insensible à la casse). « Mot de passe oublié » aussi. Réponse identique si le compte n'existe pas (pas d'énumération).

**R-EVO-43 — Historique complet (EV-M04).** La liste des tickets d'un adhérent indique le ou les modes de règlement de chacun, y compris hors cagnotte.

**R-EVO-44 — Droit à l'image (EV-T07).** Case « accepte l'utilisation de son image » sur la fiche adhérent, avec la date de recueil, visible dans l'export des adhérents. Non cochée par défaut ; à la migration, valeur « non renseigné ».

## 6. Cagnotte exacte et comptabilité

**R-EVO-50 — Rapport d'écart de cagnotte (EV-T04).**
- Pour chaque foyer : solde v1 (`ADHSOLDE`), solde v2 recalculé, solde reconstitué depuis l'historique des opérations, écart et cause probable (recharge sans écriture, doublon, ticket annulé…).
- Export Excel remis au bureau ; la page Intégrité (CAG-01..03) pointe vers ce rapport.
- *Critère* : les écarts sont listés par foyer ; chaque foyer sans écart est marqué « vert ».

**R-EVO-51 — Consolidation juillet–septembre (EV-T05). Voir Q3.**
- Défaut : exercice du 1er juillet au 30 juin. La clôture de juin fournie est reprise (import des écritures, ou soldes de report à nouveau), puis les écritures de juillet, août et septembre sont recalculées dans le nouvel exercice.
- Un écran de contrôle compare les soldes d'ouverture aux soldes de clôture de juin.
- Si l'exercice est civil, une clôture de période (verrouillage d'écritures sans clôturer l'exercice) est ajoutée à la place.

## 7. Documentation (non fonctionnel)

- **EV-T01** `docs/maintenance.md` : compétences (TypeScript, React, PostgreSQL), mise en route, déploiement, restauration, rotation des secrets.
- **EV-T02/T03** : note d'hébergement et de sécurité, copie externe des sauvegardes, registre RGPD (EV-T06 déjà traité).

## 8. Non-régression

Toutes ces règles conservent : écritures dans une transaction, requêtes paramétrées via Drizzle, journal d'audit, fonctionnement hors ligne de la caisse, textes en français.
