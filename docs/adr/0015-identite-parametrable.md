# ADR 0015 — Nom, logo et couleur de l'application paramétrables

Statut : accepté, fait en local, à déployer (pas de migration). Aucune action serveur faite.

## Contexte

Le logiciel doit pouvoir servir d'autres associations, voire des épiceries professionnelles. Le nom
« EpiSoft », le logo et le vert de l'Épicafé étaient écrits dans l'interface, les courriels, les
notifications et le manifeste de l'application installée. Les valeurs de l'Épicafé restent les valeurs
d'origine ; une autre structure les change dans Administration › Paramètres.

## Décisions

1. **Un réglage `app.branding`** (`packages/shared/src/branding.ts`) : nom du logiciel, nom court de
   l'association (début des objets de courriel, titre des notifications), couleur principale, logo
   (image de la bibliothèque, sinon le logo livré). Valeurs d'origine : EpiSoft, Épicafé, `#14532d`.
   Le nom complet, l'adresse, le SIREN et le RNA restent dans `association.identity`.
2. **Couleur** : refusée si le texte blanc n'y est pas lisible (contraste de 4,5 au moins). Elle remplace
   le vert des boutons et des liens du thème clair, la barre du navigateur et le manifeste ; le thème
   sombre garde ses couleurs.
3. **Lecture publique** (`GET /api/v1/branding`, `branding/logo/:id`, `branding/manifest.webmanifest`) :
   la page de connexion doit les afficher. Le logo n'est servi que s'il est celui qui est choisi : le
   reste de la bibliothèque d'images reste privé. L'application garde la dernière identité connue dans le
   navigateur (la caisse hors ligne la montre).
4. **Manifeste écrit par le serveur** (plus par Vite) : nom, couleur et icône viennent du réglage.
5. **Courriels** : trois variables disponibles dans tous les modèles, `{{association}}`,
   `{{association_court}}` et `{{application}}`. Les textes d'origine les utilisent, donc avec les valeurs
   d'origine le texte est celui d'avant. Un texte déjà modifié par un administrateur n'est pas touché.
6. **Notifications** : le titre est le nom court, lu au moment de l'envoi.
7. Le logo en cours d'usage ne peut pas être supprimé de la bibliothèque.

## Hors périmètre (à décider plus tard)

- Fuseau horaire `Europe/Paris`, devise, plan comptable et taux de TVA : encore supposés français.
- Les migrations depuis l'ancien logiciel (`packages/db/src/legacy`) restent : la reprise de l'Épicafé est
  la première fonction du produit.
- Le mode associatif (adhérents, foyers, cagnotte) reste sans option.
- La mise en page commune des courriels (image d'en-tête, pied de page) est déjà modifiable ; sa valeur
  d'origine, créée par la migration 0035, porte le nom de l'Épicafé.
