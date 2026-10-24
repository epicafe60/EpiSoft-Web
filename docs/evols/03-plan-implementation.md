# Plan d'implémentation des évolutions de migration

Références : besoins `01-besoins-consolides.md`, règles `02-specifications-evolutions.md`.

## Principes

- Ordre de travail pour chaque règle : fonction pure dans `packages/shared` (+ test Vitest) → API (`apps/api/src/modules/*`, migration `packages/db/drizzle/0019+`) → écran (`apps/web`) → test e2e (`e2e/tests/`).
- Chaque lot finit par `pnpm test` et `pnpm e2e` verts. Commits : une règle `R-EVO-nn` citée par commit.
- Le journal des anomalies niveau 1 du classeur (états vert/orange) est mis à jour à la fin de chaque lot.

## Lot E0 — Correctifs bloquants (1 à 2 jours)

| Tâche | Règle | Détail |
|---|---|---|
| Création produit | R-EVO-22 | Lire la ligne « erreur interne » du journal API. Vérifier que la migration `0018_shop_visible` est appliquée sur la base testée. Ajouter un test API de création complète (stock minimum 0, tous les champs). Améliorer le message du gestionnaire d'erreurs (`apps/api/src/plugins/errors.ts`). |
| TVA de facture | R-EVO-20 | Reproduire dans le navigateur ; test e2e de saisie → enregistrement → réouverture ; colonnes HT/TVA/TTC dans `routes/supplies/invoices.tsx`. |
| Commandes annulées | R-EVO-12 | `DELETE /purchase-orders/:id` accepte CANCELLED sans réception (`orders.ts`) ; bouton dans la liste. |
| Filtre fournisseur | R-EVO-13 | `supplierId` dans `GET /products` (`catalog/routes.ts`), filtres dans `routes/catalog/list.tsx` et `routes/supplies/stock.tsx`. |

## Lot E1 — Niveau 1, critique pour la migration

| Tâche | Règle | Fichiers principaux |
|---|---|---|
| Adhérent obligatoire + montant d'adhésion de passage modifiable | R-EVO-01 | `packages/shared/src/pos.ts` (validation du montant ≥ 0), `apps/web/src/till/sale.tsx` (champ montant à l'ajout de l'adhésion de passage, ligne `sale.tsx:570`), opération de vente et `sync.ts` (montant d'origine + montant saisi sur la ligne), test e2e du cas 3 € au lieu de 5 € |
| Clôture sécurisée | R-EVO-05 | `till/closing.tsx`, `apps/api/src/modules/pos/routes.ts` (annulation par responsable), droit de rôle dans `shared/roles.ts` |
| Commande sur toutes les références | R-EVO-10 | `supplies/orders.ts` (« Préparer »), `routes/supplies/orders.tsx` (éditeur), `shared/supplies.ts` |
| Inventaire prêt | R-EVO-30 | `stock/routes.ts`, `routes/supplies/inventories.tsx`, `pos` (refus de vente si gel), migration (indicateur de gel) |
| Réception ajustable | R-EVO-11 | Vérification du `ReceiveDialog`, décision Q4 |
| Rapport d'écart cagnotte | R-EVO-50 | `packages/db/src/legacy/lot1.ts`, `apps/api/src/modules/admin/integrity.ts`, `routes/admin/integrity.tsx` |
| Consolidation comptable | R-EVO-51 | `accounting/closing.ts`, `routes/compta/closing.tsx` ; dépend de la réponse Q3 et du fichier de clôture de juin |

Point de décision : une fois E0 et E1 verts, le bureau peut décider de la migration.

## Lot E2 — Niveau 2

| Tâche | Règle | Détail |
|---|---|---|
| Session magasin | R-EVO-06 | ADR 0006 avant le code (modèle de session commune, synchronisation hors ligne par poste, migration de `cash_session`). Sous-totaux par caissier à la clôture. Changement de caissier par liste et PIN. |
| Recherche déroulante | R-EVO-03 | `till/sale.tsx`, `shared/pos.ts` (`lookupProduct`), snapshot Dexie. |
| Règlement explicite | R-EVO-02 | `till/payment.tsx` : retirer la présélection d'Espèces. |
| Ticket par courriel | R-EVO-40 | `apps/api/src/lib/receipts.ts`, `sync-service.ts` (envoi systématique, soldes), migration `member.ticket_email_opt_out`, fiche adhérent, `email.enabled`. |
| Cagnotte visible | R-EVO-04, R-EVO-41 | `sale.tsx` (couleur), `routes/shop/household.tsx`. |
| Guide de maintenance | EV-T01 | `docs/maintenance.md`. |

## Lot E3 — Niveau 3 et non classés

| Tâche | Règle |
|---|---|
| Bon de commande identique + `mailto:` | R-EVO-14 |
| Réception depuis la caisse, « saisi par » | R-EVO-11 |
| Données fournisseurs (rapport d'audit) | R-EVO-15 |
| Combobox fournisseur, popup de commande | R-EVO-20 |
| Export Excel des factures | R-EVO-21 |
| Étiquettes sans code-barres, pastilles | R-EVO-07 |
| Droit à l'image | R-EVO-44 |
| Connexion par courriel | R-EVO-42 |
| Modes de règlement dans l'historique | R-EVO-43 |
| Notes hébergement/sécurité, copie externe des sauvegardes | EV-T02, EV-T03 |
| Saisie de don en caisse (action « Don », don dans un ticket, annulation) | R-EVO-08 |

Détail R-EVO-08 : opération `DONATION` dans `packages/shared/src/sync.ts` et `pos.ts` (validation du montant, modes autorisés) ; création du `member_payment` de motif `DONATION` côté `apps/api/src/modules/pos/` (sync-service) ; prise en compte dans `pos/closing.ts` (encaissements hors ventes) et `accounting/auto.ts` (754000, déjà géré pour le produit `01004`, à étendre aux paiements de motif `DONATION`) ; écran dans `apps/web/src/till/` ; tests unitaires, API (clôture + écriture) et e2e hors ligne. Remonter en lot E2 si le bureau le classe niveau 2.

## Parallèle (sans code)

- Réponses aux questions Q1 à Q7 par le bureau avant le lot qui les concerne (Q3 avant E1, Q4/Q5 avant E1, Q1 avant E2).
- Comparaison du bon de commande avec le PDF de la v1.
- Enquête « cagnottes folles » : fournir les montants exacts pour valider R-EVO-50.

## Vérification

- Unitaires : `pnpm test` (règles partagées, API).
- E2E : `pnpm e2e` — ticket sans adhérent bloqué, règlement sans mode bloqué, clôture avec confirmation puis annulation, commande plein fournisseur, facture avec TVA, ticket courriel avec soldes, inventaire avec gel, caisse hors ligne (`till-offline-*`).
- Recette manuelle des points niveau 1 avec Julie, Renée et Dominique ; mise à jour des états du classeur.

## Risques

- Session magasin (R-EVO-06) : touche le protocole de synchronisation hors ligne ; prévoir un ADR et des tests e2e hors ligne avant de coder.
- Consolidation comptable (R-EVO-51) : dépend d'une donnée externe (clôture de juin) et de la réponse Q3.
- Envoi automatique de courriels : respecter `email.enabled` et le consentement/désinscription.

## Suivi d'implémentation (24/10/2026)

Décisions et écarts : `docs/adr/0006-evolutions-migration.md`. Tests : `apps/api/test/evo-e0.test.ts`,
`pos.test.ts`, `closing.test.ts`, `lot2.test.ts`, `auth.test.ts`, `e2e/tests/till-evo.spec.ts`.

| Besoin | État |
|---|---|
| EV-C01 session commune, EV-C02 recherche déroulante, EV-C03 adhérent obligatoire, EV-C04 règlement explicite, EV-C05 cagnotte colorée | Fait |
| EV-C06 montant de l'adhésion de passage modifiable, EV-C09 don | Fait |
| EV-C07 confirmation de clôture | Fait ; la réouverture par COMPTA est ouverte côté API, l'écran reste dans Administration |
| EV-C08 étiquettes sans code-barres + pastilles | Fait |
| EV-A04 inventaire (gel, feuille de comptage, contrôle) | Fait |
| EV-A05 commande sur toutes les références, EV-A07, EV-A08 | Fait |
| EV-A06 / EV-A03 correction de réception, « saisi par » | Fait ; réception depuis la caisse non faite |
| EV-A09 audit fournisseurs | Fait |
| EV-A10 combobox fournisseur, EV-A11 popup de réception, EV-A14 export Excel des factures | Fait |
| EV-A12 TVA de facture, EV-A13 création de produit | Non reproduits (tests de non-régression ajoutés) ; à revérifier sur la base du serveur (migrations appliquées ?) et dans le journal de l'API |
| EV-A01 bon de commande identique à la v1 | Non fait : il faut un exemplaire du PDF de la v1 |
| EV-A02 messagerie | Fait (`mailto:`) |
| EV-M01 ticket courriel, EV-M02 accueil adhérent, EV-M03 connexion par courriel, EV-M04 règlements dans l'historique | Fait |
| EV-T01 à T03 documentation | `docs/maintenance.md` ; copie externe des sauvegardes à mettre en place |
| EV-T04 rapport de cagnotte, EV-T05 soldes d'ouverture | Fait (rapport par foyer, contrôle des à-nouveaux) ; la consolidation reste à valider avec le trésorier |
| EV-T07 droit à l'image | Fait |
