# ADR 0016 — Information produit, mentions bio et local, traçabilité des lots, RGPD

Statut : accepté, fait en local, à déployer (migrations 0040 et 0041). Aucune action serveur faite.

## Contexte

Le logiciel doit respecter le règlement UE 1169/2011 (allergènes, ingrédients, origine), les règles
d'étiquetage bio (règlement UE 2018/848) et « local » (DGCCRF), la traçabilité alimentaire (règlement CE
178/2002, art. 18) et le RGPD. L'association n'a pas d'indulgence particulière : une donnée incomplète est
refusée, avec une phrase claire.

## Décisions

1. **Produit alimentaire** : case `is_food`. Pour un produit alimentaire (hors service) sont obligatoires
   la décision sur les allergènes (« Aucun allergène déclaré » se **choisit**, `null` = pas décidé), les
   ingrédients, la quantité nette d'un produit vendu à la pièce, et l'origine quand la famille l'impose
   (fruits et légumes, miel, viande, poisson, œufs, huile d'olive). Les 14 allergènes de l'annexe II,
   plus « peut contenir des traces ». Règles pures dans `packages/shared/src/compliance.ts`.
2. **Quand c'est vérifié** : à la création ; à la modification seulement si un champ concerné change
   (type, vente, quantité, allergènes, ingrédients, origine, qualités, fournisseur, statut, boutique).
   Un simple changement de prix d'un produit ancien incomplet n'est pas bloqué : l'alerte
   `FOOD_INFO_MISSING` (« À surveiller ») le signale, la boutique ne le propose plus, l'étiquette est
   refusée.
3. **Bio** : certificat du fournisseur (numéro, organisme, fin de validité : les trois ensemble). La
   qualité « bio » est refusée à l'enregistrement sans certificat valide ; la pastille et la boutique ne
   l'affichent que tant qu'il est valide ; alertes `ORGANIC_CERT_INVALID` et `ORGANIC_CERT_EXPIRING`.
4. **Local** : champ de justification obligatoire (producteur, distance), alerte `LOCAL_UNJUSTIFIED`.
5. **Lots** : table `product_lot` (numéro de lot du fournisseur, DLC/DDM, quantité, réception). Pour un
   produit alimentaire, la réception exige le lot et la date (sauf fruits et légumes frais : le lot
   suffit). Rapport « d'un lot : réception, fournisseur, quantités, tickets, adhérents », « d'une vente :
   lots », et aide au rappel (adhérents et courriels ; la consultation est journalisée).
6. **Approximation FEFO** : la caisse n'enregistre pas le lot de chaque article. Les sorties de stock
   (ventes, pertes, retours fournisseur, corrections négatives) sont rejouées dans l'ordre du temps et
   prélevées sur les lots déjà reçus, DLC la plus proche d'abord (`allocateFefo`). Le résultat est exact si
   le rayon est servi ainsi, sinon il désigne les clients qui ont **pu** recevoir le lot. Une sortie sans
   lot (stock antérieur à la saisie des lots) est signalée à part. Les tickets annulés sont ignorés.
7. **RGPD** : table `consent` (finalité, choix, date, version du texte, mode de recueil), en ajout seul
   (trigger `history_guard`) : un retrait est une nouvelle ligne. Finalités : courriels de tickets,
   notifications, lettre d'information, droit à l'image, information sur le traitement des données. Les
   drapeaux de la fiche (`ticket_email_opt_out`, `newsletter_opt_in_at`, `image_consent_at`) restent
   la valeur d'usage ; chaque changement ajoute une ligne. Une fiche adhérent n'est pas créée sans la case
   « a pris connaissance de la politique de confidentialité ». L'adhérent retire un choix depuis « Mon foyer ».
   Pages publiques `/mentions-legales` et `/confidentialite` (réglage `legal.texts`, texte standard si
   vide), registre des traitements (Administration › Registre RGPD) généré depuis `PROCESSING_REGISTER`,
   dont un test vérifie qu'il couvre toute table qui pointe vers un adhérent. Les durées de conservation y
   sont des **références en lecture seule** : la politique paramétrable (lot F) les remplacera.

## À décider par le propriétaire

- La migration 0041 marque comme alimentaires les produits des univers 1 à 4 : tous apparaissent alors
  « à compléter » et sortent de la boutique en ligne tant que leurs allergènes et ingrédients ne sont pas
  saisis. À remplir avant de déployer, ou à retirer de la migration.
- Courriels de tickets : service par défaut tant que l'adhérent ne s'y oppose pas (R-EVO-40).
- Durées de conservation de référence (journaux 12 mois, traçabilité 5 ans après la DLC) : à valider.
