# ADR 0016 : TVA, régime daté et ventilation par taux

Date : 15 novembre 2026. Statut : acceptée (instruction du propriétaire, conformité).

## Contexte

La décision d'équipe « HT, TVA et TTC saisis librement, sans ventilation par taux » ne permettait ni une TVA exacte sur les tickets, ni un état de TVA, ni des écritures de TVA correctes. Le serveur doit garantir la cohérence, conformément à la réglementation française (TVA, plan comptable, loi anti-fraude TVA).

## Décisions

1. **Une seule source de calcul** : `packages/shared/src/vat.ts` (fonctions pures, testées).
   - Ventes : la TVA incluse est calculée **par taux** : HT = arrondi(somme des TTC du taux / (1 + taux)), TVA = TTC - HT. Jamais ligne par ligne ni ticket par ticket. Les dons sont hors champ ; les rechargements de cagnotte ne sont pas des ventes (aucune TVA).
   - Achats (fiche produit) : TVA = PA HT x taux du produit à 1 centime près, PA TTC = PA HT + TVA.
   - Factures fournisseur : une ligne par taux (taux autorisés 0, 2,1, 5,5, 10, 20 %), TVA de la ligne = HT x taux à 2 centimes près, totaux = sommes des lignes (table `supplier_invoice_vat_line`).
2. **Régime de TVA** : paramètre de l'application, daté et historisé (`vat_regime_change`, effet à partir d'une date, refusé dans un exercice clos). Trois régimes : ASSUJETTI (défaut), FRANCHISE en base (art. 293 B du CGI), EXONÉRÉ (art. 261 du CGI). Hors assujetti : aucune TVA facturée ni récupérable ; tickets avec la mention du régime, sans ventilation ; ventes comptées TTC sur 707 ; factures fournisseur en charge TTC (ventilation facultative) ; état de TVA masqué.
3. **Instantané** : chaque ticket (`sale.vat_regime`) et chaque facture (`supplier_invoice.vat_regime`) mémorise le régime en vigueur à sa date. Un changement de régime ne recalcule jamais le passé ; les écritures, les clôtures, l'état de TVA et le FEC lisent l'instantané.
4. **Écritures** : ventes, HT par compte de produit (707, 756) + TVA collectée par taux (445711 10 %, 445712 20 %, 445713 5,5 %, 445714 2,1 %) ; factures, charge HT + TVA déductible 445660 par taux / 401 TTC. Les écritures déjà validées ne sont jamais réécrites : une écriture de facture validée avant ce changement (TTC seul) reste acceptée, une régularisation de caisse suit la structure de l'écriture d'origine.
5. **Migration des factures existantes** : une ligne unique portant les totaux d'origine, au taux standard le plus proche de TVA / HT (0 % sans TVA). Approximation signalée : la ventilation réelle est inconnue, les totaux et les écritures ne changent pas. Les tickets et factures existants prennent le régime ASSUJETTI (défaut).

## Conséquences

- Les ventes d'avant l'application peuvent faire apparaître de la TVA dans l'état de TVA alors que leurs écritures sont en TTC ; à confirmer avec l'équipe comptable.
- Le ticket reste imprimable hors ligne : le snapshot de la caisse contient l'historique du régime, l'adresse et le SIREN.
