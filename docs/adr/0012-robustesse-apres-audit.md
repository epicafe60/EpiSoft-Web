# ADR 0012 — Robustesse après l'audit KV2

Statut : accepté. Complète l'ADR 0010 (corrections) et l'ADR 0011 (caissier déclaré).

## Contexte

Les corrections de l'audit KV2 étaient couvertes par des tests écrits « au cas du rapport ». Cela
prouve que le cas décrit est réparé, pas que la classe de défauts ne reviendra pas. On a cherché des
protections qui tiennent **sans que personne ait à y penser** quand le code change.

## Décisions

1. **L'accès de chaque route est testé, route par route, à partir de la table des routes**
   (`test/route-matrix.test.ts`).
   - Sans session : toutes les routes non publiques, sur dix écritures du même chemin (lettres
     encodées, `%25`, barre finale, `;x=1`, `/./`…), répondent 401, 403 ou 404, jamais des données.
   - Avec une session sans le rôle : chaque route protégée répond 403.
   - Chaque rôle déclaré par une route la franchit.
   - Une route ajoutée demain est testée sans qu'on écrive une ligne.
2. **Le contrôle des rôles se fait dès l'arrivée de la requête**, avant la validation du corps et des
   paramètres (`config.roles`, lu dans le crochet `onRequest`). Avant, une personne sans le rôle
   recevait le détail du schéma attendu (réponse 400) sur une cinquantaine de routes. La garde
   `requireRoles` reste en place derrière (double contrôle).
3. **La base refuse ce que le code ne devrait jamais produire** (migration 0028) : monnaie négative,
   monnaie supérieure aux espèces remises, monnaie versée en cagnotte hors espèces. Les contraintes
   sont `NOT VALID` : l'historique existant n'est pas re-contrôlé, chaque nouvelle ligne l'est.
4. **« Code vérifié » repose sur une preuve du serveur** (ADR 0011, migration 0029), et les codes
   faux sont comptés en base.
5. **Une barrière de synchronisation avant la validation d'un inventaire** (migration 0030, C02/C04).
   Les postes disent qui ils sont et combien d'opérations ils gardent à chaque rafraîchissement. Un poste
   utilisé aujourd'hui, silencieux depuis plus de 10 minutes ou annonçant des opérations, doit être
   confirmé par la personne qui valide (`409 TILLS_NOT_SYNCED`, puis « Valider quand même »).
6. **Les saisies refusées sont consignées** (Surveillance › Erreurs, « Saisie refusée : champs »),
   regroupées par route et par champs, jamais avec les valeurs, sans courriel ni compte dans
   « À surveiller ». Un formulaire qui bloque les gens se voit sans leur demander une capture.
7. **Un contrôle après déploiement** (`deploy/smoke.mjs`, sans `curl`) rejoue les contrôles de l'audit
   derrière le vrai proxy : santé, 401 par défaut, chemins encodés, en-tête anti-CSRF, documentation
   fermée, en-têtes de sécurité. `test/deploy-smoke.test.ts` prouve qu'il passe sur une application
   saine et qu'il échoue quand une protection manque.
8. **Chaîne** : audit des dépendances au niveau « modéré » (`pnpm audit --prod`), mises à jour
   hebdomadaires proposées par Dependabot, test du script de sauvegarde avec des faux `age`, `rsync`
   et disque (`test/backup-drill.test.ts`).

## Ce que ces tests ne prouvent pas

- Le comportement derrière Caddy sur le serveur réel : `deploy/smoke.mjs` s'y exécute à la main après chaque mise
  à jour (`node deploy/smoke.mjs https://…`).
- Une restauration sur une autre machine : c'est un exercice humain annuel (`docs/maintenance.md`).
- La protection de branche sur GitHub (e2e obligatoire avant fusion) : réglage du dépôt, hors du code.
