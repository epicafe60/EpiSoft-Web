# ADR 0017 — Conservation des données et taille de la base

Statut : fait en local, à déployer (migrations 0040 et 0041). Aucune action serveur faite.

## Contexte

`data_change` grossit d'une dizaine de lignes par ticket (ADR 0008), le journal des courriels garde le texte
complet de chaque message, et plusieurs tables techniques ne sont jamais vidées. Le propriétaire veut une
politique de conservation **configurable**, avec les durées légales comme plancher impossible à franchir.

## Inventaire des tables qui grossissent

| Classe (id) | Tables | Nature | Défaut | Plancher |
| --- | --- | --- | --- | --- |
| Écritures, journaux, banque, factures fournisseurs, cagnotte, adhésions, paiements, stock, commandes | `entry*`, `supplier_invoice`, `wallet_entry`, `stock_movement`… | LEGAL | jamais purgées | 10 ans (Code de commerce L123-22) |
| Tickets, lignes, règlements, sessions et clôtures de caisse | `sale*`, `cash_session`, `cash_count` | LEGAL | jamais purgées | 6 ans (LPF L102 B, L169) |
| `audit_accounting`, `data_change_accounting` | `audit_log`, `data_change` (tables comptables) | BUSINESS à plancher légal | 120 mois | 120 mois |
| `audit_sales`, `data_change_sales` | idem (tables de caisse) | BUSINESS à plancher légal | 72 mois | 72 mois |
| `audit_security` | `audit_log` (connexions, rôles, RGPD, réglages, purges) | BUSINESS | 60 mois | 12 mois (conseillé 24) |
| `audit_other`, `data_change_other` | `audit_log`, `data_change` | BUSINESS | 36 / 24 mois | 3 mois (conseillé 12 / 6) |
| `login_log` | connexions | BUSINESS | 12 mois | 1 mois (conseillé 6, CNIL) |
| `feedback` | signalements clos | BUSINESS | 24 mois | 1 mois (conseillé 6) |
| `price_history` | historique des prix (le dernier reste) | BUSINESS | 60 mois | 3 mois (conseillé 24) |
| `email_body` | contenu des courriels envoyés (la ligne reste) | TECHNICAL | 90 jours | 7 jours |
| `email_rows` | lignes du journal des courriels (jamais `PENDING`) | TECHNICAL | 24 mois | 3 mois |
| `error_log`, `sync_rejection` (classés), `integrity_run`, `job_run`, `backup_run`, `wallet_snapshot`, `sync_receipt`, `till_pin_attempt`, sessions et liens expirés | tables techniques | TECHNICAL | 1 à 24 mois, 30 jours | de 1 jour à 3 mois selon l'usage |

Non purgés par cet outil, par choix : `media` et documents de factures (légal 10 ans pour les factures ; les images
orphelines pourront faire l'objet d'un rapport), `push_subscription` (retirée à l'expiration ou à l'anonymisation),
`product_review`, `preorder`, `setting`, `db_size_snapshot` (quelques lignes par an).

Un « plancher » est un minimum de la classe : légal (message « Obligation légale… » avec la règle citée) ou de
sécurité (message « Minimum de sécurité… » avec la raison). Au-dessous d'un minimum **conseillé**, l'écran avertit sans
refuser. Une durée vide = « toujours ». Les journaux d'actions sur des données légales portent le plancher de ces
données : c'est la preuve de la façon dont les chiffres ont été obtenus.

## Décisions

1. **Réglage `data.retention`** (`packages/shared/src/retention.ts`) : durées par classe, purge de nuit (désactivée par
   défaut), copie avant purge (activée), anonymisation des inactifs (désactivée par défaut, 3 ans : question Q8),
   seuils d'alerte (base 2 048 Mo, disque libre 10 %). La validation refuse une durée sous un plancher.
2. **Un moteur, un prédicat.** `app.retention_run(kind, cutoff, batch, mode, keys)` (migration 0041) contient, une
   seule fois, la condition de chaque type de données ; l'aperçu (`count`), l'archive et la suppression l'utilisent :
   ils ne peuvent pas diverger. La liste des types est fermée : une table d'historique ou comptable est refusée.
3. **Garde-fous de la base inchangés pour l'historique.** `history_guard` et `entry_guard` ne sont pas touchés. Les
   journaux (`audit_log`, `data_change`) sont append-only : `audit_log_immutable` laisse passer un `DELETE` seulement si
   `episoft.purge = on` **et** si le rôle courant possède la table. L'application (`episoft_app`) ne la possède pas
   après la séparation des rôles et n'a pas le droit `DELETE` sur les journaux : elle passe par la fonction
   `SECURITY DEFINER`, qui n'agit que sur la liste fermée. Avant la séparation des rôles, comme pour `history_guard`,
   la protection vient avec elle (docs/maintenance.md).
4. **Pas de récursion dans `data_change`.** Pendant la purge (même condition de propriétaire), `capture_change` ne
   copie pas les suppressions : sinon chaque ligne purgée en écrirait une autre. La purge est notée par **une** ligne
   d'audit `retention.purge` (classes, nombre de lignes, date limite, taille avant/après, nom de l'archive), non
   annulable (suppression définitive ; seule l'archive subsiste).
5. **Lots et verrous.** Un lot = une transaction (2 000 lignes), pause entre lots, limite de temps pour la purge de
   nuit (30 min, le reste va à la nuit suivante), une purge à la fois. La purge manuelle tourne en tâche de fond et
   l'écran la suit.
6. **Archive avant purge.** Fichier `.jsonl.gz` (une ligne `{class, table, row}` par ligne supprimée) écrit et vidé
   **avant** la validation de chaque lot, dans `ARCHIVE_DIR` (défaut `./archives`, mode 0600). Il contient des données
   personnelles : téléchargement réservé aux ADMIN (tracé `export.file`), effacement automatique après 30 jours,
   suppression manuelle possible (`retention.archive_delete`). Les sessions, liens de mot de passe et essais de code ne
   sont jamais archivés.
7. **Adhérents inactifs** (spec Q8, 3 ans par défaut, configurable). Activité = la plus récente de : connexion (de
   l'adhérent ou de son foyer), achat, mouvement de cagnotte, paiement, fin d'adhésion, précommande, création de la
   fiche. Exclus et listés : cagnotte non nulle, rôle, précommande en cours, signalement ouvert, courriel en attente.
   Réutilise `anonymizeMember` (extrait de la route, mêmes protections, `app.scrub_member`) ; contrôle refait dans la
   transaction de chaque adhérent ; 200 par nuit au plus.
8. **Taille de la base** (Administration › Base de données) : taille de chaque table et index, plus gros
   consommateurs, relevé hebdomadaire et après chaque purge (`db_size_snapshot`), gain estimé, alertes « À surveiller »
   `DB_SIZE` et `DISK_LOW` (espace du disque lu avec `statfs` sur `DISK_CHECK_PATH`, défaut le dossier de lancement ;
   rien si le système ne le dit pas). `VACUUM FULL` n'est jamais lancé : l'écran explique quand et comment.
9. **Registre des traitements (lot E)** : `retentionRegister(settings)`, `RETENTION_CLASSES` et `LEGAL_RETENTIONS`
   (`packages/shared`) donnent les durées en vigueur, sans phrase à recopier.

## Décisions à prendre par le propriétaire

- Planchers retenus par prudence pour les **journaux** d'actions et de modifications sur la comptabilité (10 ans) et la
  caisse (6 ans) : à confirmer ; les descendre gagnerait beaucoup de place (`data_change` des tickets).
- Activer la purge de nuit et l'anonymisation automatique (désactivées à la livraison).
- Durées proposées pour les journaux de sécurité (60 mois) et de connexions (12 mois).
- Cagnotte, paiements, stock et commandes rangés au plancher de 10 ans (pièces de comptabilité) : à confirmer.
