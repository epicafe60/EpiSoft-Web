# ADR 0016 — Caisse inaltérable (art. 286 I 3° bis CGI, exigences NF525)

Statut : accepté, fait en local, **à déployer** (migrations 0040 et 0041, nouveau réglage `FISCAL_SEAL_KEY`).
Complète les ADR 0008 (audit), 0009 (une caisse par jour) et 0013 (protections de l'historique).

## Contexte

Orientation du propriétaire : aucune indulgence. La caisse doit satisfaire la loi anti-fraude à la
TVA (art. 286 I 3° bis du CGI, BOI-TVA-DECLA-30-10-30) et les exigences de la certification NF525,
même si l'Épicafé peut en être dispensé : le produit vise aussi des épiceries professionnelles.
Les quatre conditions de la loi sont **inaltérabilité, sécurisation, conservation, archivage**.

## Ce qui existait (ADR 0008, 0009, 0013)

| Exigence | Avant ce lot |
| --- | --- |
| Pas de modification d'un ticket | `history_guard` (0031) : le rôle applicatif ne modifie ni ne supprime `sale`, `sale_line`, `sale_payment` |
| Numérotation continue | numéro serveur `T-AAAA-NNNNNN`, compteur sans trou (`number_counter`), **attribué à la synchronisation** |
| Ticket hors ligne | numéro provisoire `CAISSE1-n`, où `n` est le numéro **d'opération** du poste (partagé avec les ouvertures de session et les recharges) : il a donc des trous et rien ne le scelle |
| Traçabilité | journal d'audit (ADR 0008), non chaîné |
| Clôtures | clôture de **session** de caisse seulement ; rouvrable ; pas de clôture mensuelle ni annuelle ; pas de cumul perpétuel |
| Avoir | annulation du ticket entier uniquement |
| Duplicata | rien : un ticket se réimprime sans trace |
| Plafond d'espèces | rien |
| Archive | export Excel, non signé |

Un administrateur de la base (rôle propriétaire) peut en revanche réécrire n'importe quoi sans que
l'application s'en aperçoive : c'est le trou principal, car il n'y a ni empreinte ni chaîne.

## Décisions

### 1. Le numéro imprimé sur le ticket hors ligne

Contrainte : le ticket est imprimé **avant** que le serveur ne réponde, donc avant le numéro
`T-AAAA-NNNNNN`. Ce qui est remis au client est le numéro du document : il ne peut pas être
« provisoire » au sens fiscal.

**Décision : le numéro imprimé est le numéro définitif du ticket.** C'est un numéro **de caisse**
(`CAISSE1-000123`), sans trou, unique, jamais réutilisé, scellé localement :

- chaque poste tient un compteur de documents `ticketSeq` (tickets, annulations, avoirs : tout
  document comptable), séparé du numéro d'opération. Il est incrémenté **dans la même transaction
  IndexedDB** que l'écriture du ticket dans la file d'envoi : pas de ticket sans numéro, pas de
  numéro sans ticket, aucun trou sans qu'on le voie ;
- le numéro est `NOMDUPOSTE-` + `ticketSeq` sur 6 chiffres ; le nom d'un poste est unique et ne
  change pas (un poste réinitialisé est un **nouveau** poste : numéro neuf, jamais de réutilisation) ;
- le ticket est scellé : `hash = SHA-256(hash_précédent | JSON canonique(champs))`, un chaînage
  **par poste**, calculé par le poste avant l'impression et envoyé avec l'opération (`seal`) ;
- le serveur **recalcule** l'empreinte, vérifie la continuité (`seq` = précédent + 1, `prev` = empreinte
  du précédent) et conserve tout : `register_seq`, `till_hash`, `till_prev_hash`, `till_seal_status`.
  Une incohérence **n'efface pas le ticket** (il a été remis à un client et l'argent est entré) : il
  est enregistré avec l'avertissement `SEAL_*` et l'anomalie remonte dans les contrôles d'intégrité
  (FIS-03). Refuser reviendrait à perdre une vente ;
- le numéro serveur `T-AAAA-NNNNNN` reste attribué à la synchronisation : c'est la **clé comptable
  interne** (continue, par année). Il est rattaché au numéro de caisse (`sale.provisional_number`)
  par une correspondance 1-1 qui est sous la chaîne serveur : modifier l'un casse l'empreinte.
  Les deux numéros figurent sur le courriel, dans les listes et dans l'archive du contrôleur.

Alternative écartée : imprimer « PROVISOIRE » puis réimprimer avec le numéro définitif. Cela
produit deux documents pour une même vente (l'un jamais remplacé si le client est parti).

### 2. Chaînage de hachage (inaltérabilité, sécurisation)

Deux chaînes, aux rôles distincts :

1. **Chaîne du poste** (ci-dessus) : preuve que le ticket remis au client est celui que le serveur
   a reçu, et détecteur de perte ou de réutilisation de numéro hors ligne.
2. **Chaîne du serveur** (`fiscal_journal`), globale, sans trou, **une entrée par événement** :
   ticket, annulation, avoir, ouverture et clôture de session, duplicata, clôtures de période. Chaque
   entrée porte son rang `seq`, l'instant, le type, un instantané canonique des champs (`data`),
   l'empreinte précédente, l'empreinte, et une **signature HMAC-SHA256** de l'empreinte par une
   clé que la base ne contient pas (`FISCAL_SEAL_KEY`, dans `/etc/episoft/`).

Pourquoi une signature en plus de la chaîne : sans elle, qui a la main sur la base peut recalculer
toute la chaîne après avoir falsifié un montant. Avec la clé hors de la base, il faut en plus
compromettre le serveur d'application. La limite subsiste (un administrateur système qui a aussi la clé) ;
elle est réduite par l'**archive signée** conservée hors du serveur (§8) et par le **cumul perpétuel**
imprimé sur chaque Z, que la boutique conserve.

Les données canoniques d'un ticket sont recalculables depuis `sale`, `sale_line`, `sale_payment` :
le contrôle FIS-01 les recalcule et les compare à l'instantané ; modifier un montant en SQL, même
en propriétaire, fait échouer le contrôle. `fiscal_journal` est protégé comme l'historique
(`history_guard` sans colonne libre).

JSON canonique : clés triées, pas d'espaces, décimaux normalisés sans zéros inutiles, dates en
ISO 8601 UTC à la milliseconde. Spécifié et testé dans `packages/shared/src/fiscal.ts`.

### 3. Clôtures de période (« Z »)

Table `period_closing` : jour (`DAY`), mois (`MONTH`), année (`YEAR`). Une clôture porte : nombre de
tickets, d'annulations, d'avoirs, totaux TTC **par taux de TVA** (`byVat` : le lot B fournit
HT et TVA, les champs sont prévus, rien n'est recalculé ici), par moyen de paiement, premier et
dernier numéro, **cumul perpétuel** `grand_total` = cumul de la valeur absolue de tous les
documents (ventes, annulations et avoirs s'ajoutent : il ne diminue jamais), et son entrée chaînée
dans le journal. Règles :

- un jour ne se clôture qu'une fois (`unique (kind, period_start)`) ; les jours se clôturent dans
  l'ordre ; le cumul d'une clôture est celui de la précédente + la valeur absolue de ses documents ;
- une clôture de jour exige que toutes les sessions de caisse du jour soient closes ;
- un mois (une année) se clôture quand il est fini et que tous ses jours (mois) ayant eu de
  l'activité sont clos ; ses totaux sont recalculés **et** doivent égaler la somme des clôtures
  enfants (contrôle FIS-04) ;
- **aucun ticket ne s'ajoute à une période close** : colonne `sale.accounting_day` (jour comptable),
  verrou partagé pendant l'enregistrement d'un ticket, verrou exclusif pendant la clôture, et
  déclencheur `sale_period_guard` qui refuse l'insertion même si le code se trompait ;
- **le cas hors ligne** : un ticket émis à 17 h par un poste déconnecté peut arriver après la clôture
  de 18 h. Il ne peut ni être refusé (le client l'a), ni changer un Z imprimé. Il est enregistré
  avec son `sold_at` et son numéro de caisse d'origine, l'avertissement `LATE_AFTER_CLOSING`, et
  **porté au premier jour comptable non clos** ; le Z de ce jour le compte (le détail se retrouve
  par `sold_at` ≠ `accounting_day`) ;
- une session dont le jour est clos **ne peut plus être rouverte** (`session.reopen` refusé) ;
- une tâche de nuit clôt les jours écoulés dont toutes les sessions sont closes.

### 4. Duplicata

Une réimpression imprime « DUPLICATA » (et le rang de la copie) et est journalisée : opération
`TICKET_REPRINT` (utilisable hors ligne, envoyée comme les autres), table `ticket_reprint`,
audit `sale.reprint`, entrée `DUPLICATA` dans le journal chaîné.

### 5. Avoir et retour partiel

Opération `SALE_RETURN` : retour de lignes choisies (quantités) d'un ticket, enregistré comme un
document négatif relié à l'original (`sale.returns_sale_id`, `sale_line.returns_line_id`), avec motif
obligatoire, moyen de remboursement unique, remise en stock facultative. Le serveur calcule les
montants (prix et remise au prorata, la dernière fraction prend le reste : jamais plus que la ligne
vendue) ; un moyen de remboursement ne peut dépasser ce qui avait été payé par ce moyen (la cagnotte
est toujours possible pour un adhérent) ; un ticket annulé n'a pas d'avoir et un ticket déjà en
partie remboursé ne s'annule plus en entier. L'annulation entière reste. Sans remise en stock, la
marchandise est comptée en perte (`LOSS`).

### 6. Plafond des paiements en espèces

Art. D112-3 du code monétaire et financier : 1 000 € pour un paiement d'un consommateur résident
fiscal en France (15 000 € pour un non-résident). Constante `CASH_PAYMENT_LIMIT_CENTS` dans
`packages/shared/src/fiscal.ts` avec la référence ; fonction `cashPaymentProblem`. **Refus** à la
caisse (écran de paiement). Le serveur, lui, **enregistre** un ticket reçu au-dessus du plafond (un
poste ancien, une saisie déjà faite) avec l'avertissement `CASH_LIMIT_EXCEEDED` et le contrôle
FIS-05 : refuser perdrait une vente déjà encaissée. Le lot D réutilise la même fonction pour les
paiements fournisseurs en espèces (route non modifiée ici).

### 7. Journal des événements

L'audit (ADR 0008) couvre ouverture et clôture de session, annulations, ventes. Ajouts :
`sale.return`, `sale.reprint`, `period.close`, `fiscal.archive`. Les événements requis par la norme
sont **aussi** dans la chaîne signée : ouverture de session, clôture de session, duplicata,
annulation, avoir, clôtures de période. Non fournis : ouverture du tiroir-caisse (aucun matériel
connecté : à ajouter avec l'imprimante) ; changement de caissier (déjà porté par chaque ticket :
`cashier_id`, `cashier_check`).

### 8. Conservation et archive

- **Conservation : 6 ans** à compter de la clôture de l'exercice concerné (LPF art. L102 B et
  L169 : trois ans de droit de reprise, six ans de conservation retenus par la norme et l'usage).
  Tickets, lignes, paiements, clôtures et journal ne sont **jamais purgés** ; c'est une obligation
  légale qui prime sur le RGPD. L'anonymisation d'un membre inactif (R-MBR-08) laisse montants et
  numéros de ticket.
- **Archive** : `GET /admin/fiscal/archive?from=&to=` produit un fichier JSON signé (tickets, lignes,
  paiements, clôtures, journal, empreintes, numéros de caisse et de serveur) avec un manifeste (nombre
  et SHA-256 de chaque section, dernière empreinte) et une signature HMAC.
  `POST /admin/fiscal/archive/verify` et `verifyArchive` (`packages/shared`) recontrôlent sections,
  chaîne et signature ; **sans la clé**, sections et chaîne se vérifient quand même. À conserver
  hors du serveur, au minimum après chaque clôture annuelle.
- **Contrôleur** : `GET /admin/fiscal/verify` recalcule la chaîne et rapporte les ruptures.
- **Format** : JSON plutôt que ZIP, pour n'ajouter aucune dépendance ; un ZIP du même fichier est
  trivial à ajouter si le contrôleur le demande.

## Conséquences

- Le numéro imprimé hors ligne vient d'un compteur de documents du poste, plus du numéro d'opération.
  Les tickets déjà émis restent valables ; un ticket sans scellé (ancien poste) est enregistré `ABSENT`.
- Rétro-remplissage : les tickets existants reçoivent `accounting_day` ; la chaîne serveur démarre à
  la migration (pas de rétro-chaînage des anciens tickets, jamais scellés : constaté, pas inventé).

## À décider par le propriétaire

1. Faut-il **refuser** côté serveur un ticket en espèces au-dessus du plafond (au prix de perdre une
   vente déjà encaissée) ? Choix actuel : l'enregistrer et le signaler.
2. Un ticket tardif arrivé après le Z est porté au jour suivant : accepter ce principe (alternative :
   bloquer le Z tant qu'un poste a des opérations en attente, impraticable hors ligne).
3. Poser `FISCAL_SEAL_KEY` (32 octets aléatoires) dans `/etc/episoft/` ; la perdre rend les signatures
   invérifiables (la chaîne reste vérifiable).
4. Certification : la loi admet une certification NF525 ou une attestation individuelle de l'éditeur ;
   ce lot rapproche le produit de la norme mais **ne vaut pas certification**.
