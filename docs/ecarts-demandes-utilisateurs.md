# Écarts entre les demandes des utilisateurs et ce qui a été construit

Document établi le 21 novembre 2026. Il liste **toutes les demandes de l'équipe de l'Épicafé, de ses adhérents et du propriétaire du projet** qui n'ont pas été reprises telles quelles : refusées, remplacées, modifiées, reportées ou pas encore faites. Pour chacune : ce qui était demandé, ce qui existe maintenant, et **le motif**.

## Sources

- `docs/evols/Expression de besoins - migration.xlsx` et sa consolidation `docs/evols/01-besoins-consolides.md` (identifiants EV-xx), règles `R-EVO-nn` (`02-specifications-evolutions.md`), suivi du 24/10/2026 (`03-plan-implementation.md`, ADR 0006).
- `docs/decisions-equipe.md` : réponses de l'équipe du 15/11/2026 (transmises par la responsable du projet).
- Instructions du propriétaire du projet pendant les sessions de novembre 2026.
- Questions ouvertes de la spécification (§11.3).

**Non consultés** : les signalements saisis dans l'application en production (ils se trouvent sur le serveur ; leur lecture demande l'accord explicite du propriétaire) et l'avis des testeurs. Ce document ne les couvre pas.

## Légende

| Statut | Sens |
|---|---|
| **Remplacé** | la demande a été remplacée par une autre règle, décidée plus tard |
| **Modifié** | réalisé, mais autrement que demandé |
| **Refusé / non construit** | volontairement pas fait |
| **Reporté** | prévu, à faire plus tard |
| **À faire** | demandé, accepté, pas encore fait |
| **À confirmer** | valeur par défaut prise en attendant une décision du bureau |

---

## 1. Remplacé ou modifié par décision du propriétaire (novembre 2026)

Consigne du propriétaire : **aucun arrangement pour l'association ; le serveur garantit la conformité à la réglementation française et le niveau des applications du marché ; une saisie incohérente est refusée**.

Le principe de l'équipe du 15/11 (« pas de contrôle, d'avertissement ni de module sans demande de l'équipe ») est donc **écarté** : les lignes 1.1 à 1.5 remplacent des décisions explicites de l'équipe ; les lignes 1.6 à 1.14 sont des contrôles et protections ajoutés **sans demande de l'équipe**, par décision du propriétaire.

| # | Demande d'origine | Ce qui existe maintenant | Statut | Motif |
|---|---|---|---|---|
| 1.1 | Dans « Passer une commande », **modifier le prix d'achat HT** de la ligne et que la **fiche produit suive** | Le prix modifié ne vaut que pour la ligne de commande (imprimée sur le bon). La fiche n'est jamais touchée à ce moment. | Modifié | Standard du marché (Odoo, Dolibarr, Zoho) : à la commande le prix est une prévision, le vrai prix est connu à la réception. Une modification à la commande faussait aussi la valeur du stock. |
| 1.2 | À la réception, **ne jamais mettre à jour** le prix de la fiche (décision d'équipe du 15/11 : vigilance des bénévoles) | La réception montre le prix de la fiche, le prix commandé, le prix reçu et l'écart (€ et %). Une case « Mettre à jour la fiche produit », **décochée par défaut**, met la fiche à jour. | Modifié | Alignement sur le marché, tout en gardant la vigilance humaine voulue par l'équipe (aucune mise à jour automatique). Le coût réel reste toujours sur la ligne de réception et alimente le coût moyen du stock. |
| 1.3 | Fiche produit : **PA HT, TVA (€) et PA TTC en trois champs libres**, sans calcul ni contrôle | Le serveur impose TVA = PA HT × taux du produit (à 1 centime) et TTC = HT + TVA ; un taux inconnu est refusé. | Remplacé | Une fiche incohérente fausse la marge, la valeur du stock et la TVA. Règle de conformité (TVA, plan comptable). |
| 1.4 | Facture fournisseur : **HT, TVA et TTC en trois champs libres**, un seul total pour plusieurs taux | La facture est saisie **par taux de TVA** (0, 2,1, 5,5, 10, 20 %). Les totaux sont des sommes calculées. Une ligne dont la TVA s'écarte de plus de 2 centimes de HT × taux est refusée. | Remplacé | La TVA déductible et la déclaration CA3 exigent le détail par taux. L'équipe l'avait écarté faute de comptabilité structurée ; le propriétaire a tranché pour la conformité. |
| 1.5 | **Aucun avertissement ni blocage** en cas d'écart d'arrondi HT / TVA / TTC | Les écarts sont refusés avec un message sous le champ. | Remplacé | Consigne « n'autorise pas de saisie erronée ». |
| 1.6 | **Ne rien concevoir en comptabilité** pour une équipe comptable qui n'existe pas encore | Écritures de vente et de facture avec TVA par taux, régime de TVA daté (assujetti, franchise, exonéré), avoirs fournisseur, annulation de facture, exercice approuvé non rouvrable, coût moyen pondéré, contrôle du FEC. | Remplacé | Ces règles sont légales (PCG, FEC, loi anti-fraude TVA) et ne dépendent pas de la présence d'une équipe comptable. |
| 1.7 | Information alimentaire (allergènes, ingrédients, origine) obligatoire | **Option** d'administration, **désactivée par défaut** (le propriétaire l'a demandé). Le lot et la date limite à la réception, la justification d'un produit « local » et le certificat d'un produit « bio » restent obligatoires. | Modifié | Demande du propriétaire : fonction optionnelle. |
| 1.8 | Vente de **n'importe quel prix**, remise libre, adhérent facultatif, mode de paiement libre au poste | Les erreurs de calcul sont **refusées** ; la remise est limitée à la ligne ; les ventes hors règle (remise désactivée, adhérent inactif, prix différent du catalogue, adhérent obligatoire non respecté) sont **acceptées et signalées** dans « À surveiller ». | Modifié | Une vente déjà faite (et surtout hors ligne) ne peut jamais être refusée après coup : le ticket est déjà donné au client. On l'enregistre et on le signale. |
| 1.9 | **Plafonds** : aucune limite sur versement, correction de cagnotte, facture, adhésion | Versement ≤ 1 000 €, correction de cagnotte ≤ 500 € (administrateur au-delà de 100 €, jamais sur son propre foyer), facture ≤ 100 000 €, adhésion au tarif du type sauf motif d'un administrateur. | Modifié | Éviter les saisies absurdes. **Seuils choisis par l'équipe technique, à confirmer par le bureau.** |
| 1.10 | **Sur-réception** (recevoir plus que commandé) acceptée avec un avertissement | Toujours refusée. | Modifié | Cohérence du stock et de la facture. **À confirmer** : un fournisseur peut livrer en trop ; une tolérance reste possible. |
| 1.11 | **Vente sous le prix d'achat** ou à 0 € acceptée | Refusée, sauf motif explicite et journalisé (périssable menacé, fin de série). | Modifié | Revente à perte interdite (art. L442-5 du Code de commerce). Le seuil légal des produits alimentaires ajoute 10 % : non repris. |
| 1.12 | Exercice clôturé **réouvrable par l'administrateur** | Réouverture réservée au dernier exercice, avec motif ; **impossible après approbation** par l'assemblée générale. | Modifié | Inaltérabilité des comptes après clôture. |
| 1.13 | Une **facture réglée** reste figée | Elle peut être **annulée avec motif** (contre-passation, jamais supprimée), le règlement peut être contre-passé. | Modifié | Corriger une erreur sans effacer l'historique. |
| 1.14 | Ticket imprimé avec le **numéro provisoire** du poste | Numéro de caisse continu et scellé, journal chaîné, clôtures Z jour/mois/année avec grand total perpétuel, duplicata, avoir et retour partiel. | Modifié | Exigences de la loi anti-fraude TVA (NF525). |

## 2. Demandes de l'équipe refusées ou non construites

| # | Demande ou piste | Statut | Motif |
|---|---|---|---|
| 2.1 | Import de PDF (factures, relevés), gabarits par fournisseur, validation avant enregistrement | Non construit | Décision d'équipe du 15/11 : les factures sont chargées par des personnes, c'est leur travail. |
| 2.2 | Lecture de documents par une intelligence artificielle | Refusé | Décision d'équipe : tout reste sur le serveur, en attendant que l'équipe sache reconstituer son premier bilan. |
| 2.3 | Module de frais de fonctionnement, notes de frais, répartition de TVA par taux sur les frais | Non construit | Pas d'équipe comptable pour s'en servir aujourd'hui. |
| 2.4 | Classement automatique des opérations bancaires à l'import d'un relevé | Non construit | Même motif. |
| 2.5 | Traitement comptable de la consommation interne (café, jus de pomme) | Non construit | Décision d'équipe : un motif « consommation interne » avec un total mensuel est acceptable s'il est simple, sinon on laisse tel quel. Non fait. |
| 2.6 | Case « remise » sur la facture fournisseur | Reporté | À rediscuter après une année de gestion comptable par la nouvelle équipe. |
| 2.7 | Avoir un **seul fournisseur** par produit (question Q6) | À confirmer | Valeur par défaut : un seul. |

## 3. Demandes acceptées, mais pas (entièrement) faites

| # | Réf. | Demande | Statut | Motif |
|---|---|---|---|---|
| 3.1 | EV-A03 / R-EVO-11 | **Réception depuis la caisse** (le caissier reporte ce que le fournisseur livre, avec son nom) | À faire | Le « saisi par » est affiché, mais l'écran de réception reste dans le module Approvisionnement. Besoin de niveau 3, non priorisé. |
| 3.2 | EV-A01 / R-EVO-14 | Bon de commande identique à celui de l'ancien logiciel | Fait pour la mise en page ; **à comparer sur un exemplaire réel** | La comparaison avec le PDF de l'ancien logiciel n'a pas été faite par l'équipe. |
| 3.3 | EV-A12 | Bug : la TVA saisie d'une facture disparaît | Non reproduit | Test de non-régression ajouté ; **à revérifier sur la base du serveur** (migrations appliquées ?). Le formulaire de facture a depuis été entièrement refait (TVA par taux). |
| 3.4 | EV-A13 | Bug : création de produit, « erreur inattendue » | Non reproduit | Même constat ; test de non-régression ajouté. |
| 3.5 | EV-T03 | Copie externe des sauvegardes | À faire | À mettre en place sur le serveur (action sur le serveur : accord requis). |
| 3.6 | EV-T05 / R-EVO-51 | Consolider juillet-août-septembre à partir de la clôture de juin | Fait côté outil ; **à valider avec le trésorier** | Exercice supposé 1er juillet–30 juin (question Q3, à confirmer). |
| 3.7 | EV-T04 / R-EVO-50 | Cagnotte « exacte » issue de l'enquête « cagnottes folles » | Rapport fait ; **49 foyers avec un écart à valider** | Écarts entre l'ancien solde et le solde reconstitué : à trancher par le trésorier. |
| 3.8 | EV-C07 / R-EVO-05 | Réouverture d'une clôture par un responsable (pas seulement l'administrateur) | Fait côté API ; l'écran restait dans Administration au 24/10/2026 (non revérifié) | Le rôle COMPTA n'avait pas son bouton. |
| 3.9 | R-EVO-06 | Session de caisse commune à plusieurs postes | Fait ; **à confirmer (Q1)** | Un poste hors ligne au démarrage ouvre sa propre session (tiroir séparé) : l'ouverture hors ligne doit rester possible. |
| 3.10 | EV-C09 | Don, avec reçu fiscal éventuel | Fait sans reçu fiscal | Question Q8 : pas de reçu fiscal pour l'instant. |

## 4. Reporté à la mise en service

| # | Sujet | Motif |
|---|---|---|
| 4.1 | Double authentification et durée des sessions (administrateurs, trésoriers) | Décision du propriétaire : à traiter quand le déploiement sera envisagé. |
| 4.2 | Dossier de certification de la caisse (attestation individuelle ou certification NF525) | Le travail rapproche l'outil de la norme sans valoir certification : à faire valider par un spécialiste. |
| 4.3 | Validation par l'expert-comptable : TVA, mention d'exonération (art. 261 du CGI), numéros de comptes de TVA | Hors du périmètre technique. |

## 5. Valeurs par défaut prises sans réponse du bureau (questions de la spécification)

| Question | Défaut appliqué | À confirmer |
|---|---|---|
| Q1 — Assujettissement à la TVA | **Assujetti** (défaut) ; trois régimes paramétrables avec date d'effet | Oui : le régime réel de l'Épicafé |
| Q3 — Exercice comptable | 1er juillet – 30 juin | Oui |
| Q4 — Réception corrigée après validation | Oui, par un responsable, avec contre-passation et audit | Oui |
| Q5 — Gel des ventes pendant l'inventaire | Option, désactivée | Oui |
| Q6 — Plusieurs fournisseurs par produit | Non | Oui |
| Q7 — Table `ecritures1` (oct.–déc. 2025) | Archivée dans le rapport de migration, non reprise | À vérifier avec le trésorier |
| Q8 — Don par un non-adhérent, reçu fiscal | Don sans adhérent accepté ; pas de reçu fiscal | Oui |
| Q10 — Stock de dépôt-vente (757,78 €) | Aucun traitement particulier relevé | À décider |
| Anonymisation des membres partis (3 ans) | Prévue, **désactivée** | À activer par l'administrateur |
| Purge des journaux (audit, courriels…) | Prévue, **désactivée** ; planchers légaux imposés | À activer par l'administrateur |

## 6. Effets de bord et points ouverts connus

- **Reprise de l'ancien logiciel** : l'import suit maintenant les nouvelles règles (marquage alimentaire des univers 1 à 4, coût moyen du stock initial, tickets et factures repris au régime exonéré par défaut, option `--vat-regime`, feuille « Conformité » dans le rapport). Restent à compléter par des personnes : 360 produits alimentaires sans allergènes ni ingrédients, 142 produits « bio » sans certificat, 399 produits « local » sans justification, 45 produits vendus sous leur prix d'achat, 9 à 0 €, 124 adhérents sans trace de consentement. Les tickets historiques restent sans scellé (voulu, ADR 0016).
- **Écran des clôtures Z et de l'archive** : l'API existe, pas l'écran.
- **Avoirs fournisseur** : l'écriture comptable de l'avoir reprend la TVA des factures, à vérifier en détail ; le rapport des dettes fournisseurs ne déduit pas les avoirs non imputés.
- **Statistiques** : un avoir est encore compté comme un ticket ; le chiffre d'affaires reste en TTC.

## 7. Ce qui a été accepté et réalisé tel que demandé (pour mémoire)

Session de caisse commune, recherche avec liste déroulante, adhérent obligatoire (avec montant d'adhésion de passage modifiable), mode de règlement explicite, cagnotte colorée, confirmation de clôture, étiquettes sans code-barres avec pastilles locale et bio (puis prix au kilo et fournisseur), inventaire avec feuilles de comptage et gel optionnel, commande sur toutes les références, effacement des commandes annulées, filtre par fournisseur, audit des fournisseurs, combobox fournisseur, fenêtre de réception, export Excel des factures, ticket par courriel avec soldes, état de la cagnotte à la connexion, connexion par courriel, règlements dans l'historique, droit à l'image, « Opérations du jour », case « à réception fin de mois » sur le fournisseur, courriels et documents PDF modifiables, nom, logo, couleur et fuseau horaire paramétrables, et l'extraction comptable des allocations.
