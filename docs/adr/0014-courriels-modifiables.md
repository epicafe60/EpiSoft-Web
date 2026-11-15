# ADR 0014 — Courriels modifiables dans l'application

Statut : accepté, fait en local, à déployer (migration 0034). Aucune action serveur faite.

## Contexte

Les textes des 20 courriels (ticket, reçu, mot de passe, rappels, alertes, signalements…) étaient écrits
dans le code : changer une phrase ou une signature demandait une modification et un déploiement.

## Décisions

1. **Un modèle par courriel, avec des variables** (`packages/shared/src/email-templates.ts`). L'objet et
   le message sont du texte avec `{{variables}}` ; chaque courriel déclare les siennes (nom, libellé,
   exemple, type). Le texte d'origine reste dans le code : une ligne `email_template` ne contient que ce
   qu'un administrateur a modifié, la supprimer remet l'original.
2. **Aucune logique dans un modèle** : pas de condition, de boucle ni de code. Une variable est remplacée
   par une valeur, rien d'autre. Un texte est échappé dans le HTML ; un fragment (tableau des articles)
   vient du code, jamais d'une personne ; une adresse n'est écrite que si elle est en http(s). Une valeur
   qui ressemble à une variable n'est pas remplacée une seconde fois.
3. **Validation à l'enregistrement** : variables inconnues refusées, variable indispensable (`{{lien}}` du
   courriel de mot de passe) exigée, fragment interdit dans l'objet.
4. **HTML nettoyé par le serveur** (`apps/api/src/lib/email-sanitize.ts`, `sanitize-html`) à
   l'enregistrement et à l'aperçu, quoi que l'éditeur ou une requête envoie : liste blanche de balises et de
   styles, pas de script, de formulaire ni de cadre, liens `http`, `https`, `mailto`, `tel` ou une variable,
   images de la bibliothèque seulement (ni image distante, ni `data:`).
5. **Une mise en page commune** (`email_layout`, une ligne) : image d'en-tête, pied de page, couleur ; tableau
   et styles en ligne, que les messageries comprennent. Le message de chaque courriel vient s'y insérer.
6. **Images intégrées au courriel** (`email_asset`) : l'image part dans le message (`cid:`, pièce jointe en
   ligne) et s'affiche sans adresse publique ni connexion au serveur. PNG, JPEG, WebP ou GIF, 500 Ko au plus,
   contenu vérifié (signature), pas de SVG. Une image utilisée ne se supprime pas ; une image supprimée
   depuis un courriel disparaît du message sans le casser. L'aperçu (cadre isolé) et le journal des
   courriels les montrent en `data:`.
7. **Éditeur** : texte riche (TipTap) avec liste de variables, liens, images de la bibliothèque et couleur,
   plus l'onglet code HTML ; aperçu côté serveur avec les valeurs d'exemple ; « M'envoyer un essai » ; remise
   à l'original avec confirmation. Réservé aux ADMIN (Administration › Courriels).
8. **Journal** : modification, remise à l'original, essai, mise en page, ajout et suppression d'image sont
   dans le journal d'audit (la modification et l'ajout d'image sont annulables depuis le journal).

## À savoir

- Les alertes « une par heure » comparent l'objet rendu : changer l'objet d'un modèle ne casse pas la règle.
- Le courriel de commande fournisseur est un modèle (`purchase_order`) : son texte est proposé dans la fenêtre d'envoi
  (variables remplies), reste modifiable à chaque envoi, puis part dans la mise en page commune, avec le PDF joint.
- Un courriel déjà dans la file d'envoi garde le texte avec lequel il a été écrit.
