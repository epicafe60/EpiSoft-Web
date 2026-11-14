# ADR 0013 — Revue de sécurité et de cohérence de novembre 2026

Statut : accepté, fait en local, **à déployer** (migration 0031 ; aucune action serveur faite).
Complète les ADR 0010 à 0012. Origine : revue demandée pour répondre à un auditeur
(plan : constats E, M, F).

## Décisions

1. **L'historique ne se supprime ni ne se réécrit** (M1, migration 0031). Un déclencheur
   `history_guard` interdit au rôle de l'application de supprimer ou modifier une ligne de `sale`
   (sauf état, avertissements, courriel envoyé, remise recalculée), `sale_line`, `sale_payment`,
   `stock_movement`, `wallet_entry` et `member_payment`. Le propriétaire des tables
   (`episoft_owner`) n'est pas concerné : migrations, restauration, réparation à la main.
2. **L'annulation d'un versement le jour même est une contre-écriture** (R-CAG-08). Le versement
   reste ; une écriture `CORRECTION` de montant opposé (`cancels_entry_id`, une seule par versement)
   et un paiement opposé l'annulent. Le contrôle CAG-02 reste vrai. L'annulation depuis le journal
   d'audit passe par la même fonction (`members/wallet-cancel.ts`).
3. **Le verrou des écritures validées ne se lève plus par un réglage de session** (M2). La levée
   (`app.bypass_entry_guard`) ne compte que pour le propriétaire des tables. La réouverture d'un
   exercice passe par `app.remove_closing_entries()` (`SECURITY DEFINER`, exercice clôturé
   seulement, uniquement les écritures de clôture).
4. **Le serveur ne croit pas les dates du poste** (M3). `recordedTime()` (partagé) : une heure dans le
   futur (au-delà de la tolérance `clockFutureMin`) est remplacée par celle du serveur et signalée
   (`CLOCK_SKEW`) ; une heure antérieure à l'ouverture de la session est gardée et signalée
   (`CLOCK_BEFORE_SESSION`). Vaut pour ventes, annulations, recharges et ouvertures de session. Le
   numéro de ticket, la cagnotte et le stock portent donc l'heure retenue.
5. **Un fond de caisse négatif est refusé** (M4) par le code et par une contrainte de la base ;
   une recharge au-dessus du seuil `topupAmount` est enregistrée avec l'avertissement `TOPUP_HIGH`.
6. **Une personne inconnue du serveur est refusée proprement** (F2) : caissier ou ouvreur
   inconnu → `REJECTED`, consigné dans Surveillance, au lieu d'une erreur renvoyée sans fin qui
   bloquait la file du poste.
7. **Une annulation tardive après un inventaire est régularisée** (F3), comme une vente tardive
   (C04) : mouvement `INVENTORY` tracé et avertissement `INVENTORY_LATE_CANCEL`.
8. **Durcissements** : SMTP chiffré obligatoire en production hors port 465 (M6) ; l'export complet
   exclut les abonnements de notification et les preuves de code caissier (F6) ; la CI passe en
   `contents: read` (F7).

9. **« Exporter en Excel » sur toutes les listes, selon le rôle** (`POST /exports/table`). Un seul
   composant (`Table`) lit le tableau affiché (filtres et tri compris) et l'envoie ; le serveur écrit
   le fichier. L'accès suit le rôle de l'écran d'où part l'export (`EXPORT_SCOPES` : le rôle qui ouvre
   l'écran, et ADMIN ; les écrans personnels sont ouverts à tout membre connecté ; une page inconnue
   est réservée aux ADMIN). Le serveur contrôle la portée, la taille (20 000 lignes, 60 colonnes,
   6 Mo), le type de chaque cellule, la cadence (10 par minute) et journalise chaque fichier (qui,
   écran, lignes). Un texte n'est jamais écrit comme une formule. Fermé pendant qu'un autre caissier
   tient la caisse. **Limite assumée** : le serveur ne lit rien en base pour cet export, il ne peut
   donc pas prouver l'origine des lignes ; il ne donne que ce que l'API laissait déjà voir, sous le
   rôle de l'écran déclaré. Les tableaux qui ne sont pas des listes (caisse, détail d'un ticket,
   formulaire, rapports qui ont leur export) déclarent `exportable={false}`.

## À savoir

- Avant la séparation des rôles de la base, l'application est propriétaire des tables : les gardes
  1 et 3 ne la retiennent pas. Elles tiennent depuis la bascule faite le 8 novembre
  (`docs/maintenance.md`, « Database roles »). Les tests rejouent cette bascule.
- Le script de migration depuis l'ancienne application doit tourner en `episoft_owner` (il lève la
  garde des écritures).
- Contrainte `cash_session_opening_float_not_negative` : `NOT VALID`. Les sessions existantes ne
  sont pas re-contrôlées ; `VALIDATE CONSTRAINT` après vérification sur le serveur.

## Reste à faire (hors code ou décision)

Second facteur ADMIN/COMPTA (E3), copie de sauvegarde hors site et restauration sur une autre
machine (E2), durcissement du serveur (M5), plafond de tentatives du code caissier avec alerte (F1),
barrière d'inventaire liée au poste (F5), contrôle d'intégrité total = lignes = règlements (F4),
épinglage des actions GitHub par empreinte (F7), commit et déploiement (E1).
