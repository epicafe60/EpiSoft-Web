# ADR 0010 — Corrections de l'audit KV2

Date : 2026-11-07. Statut : accepté (corrections faites en local, à déployer).

## Contexte

L'audit externe KV2 (`apps/audit/`) a relevé 17 constats sur le commit `aff2492`. 14 étaient
confirmés dans le code. Aucun ne venait de l'ancienne application : ils sont tous apparus pendant la
réécriture. L'analyse et l'état de chaque correction sont dans `apps/audit/Analyse_et_resultats.md`.

## Décisions

1. **L'accès se décide sur la route reconnue, jamais sur le texte de l'URL** (S01). Les contrôles
   globaux (session, anti-CSRF, repli de la SPA) utilisent `isApiRequest()`.
2. **Chaque route a une règle d'accès déclarée et testée.** `requireRoles` marque ses gardes,
   l'application recense ses routes, et `test/route-access.test.ts` exige que chaque route soit
   publique, réservée à des rôles, ou listée comme ouverte à tout membre avec son propre contrôle.
3. **L'identité d'un compte de l'équipe n'est modifiable que par un ADMIN** : courriel,
   identifiant, désactivation, archivage (S02). Tout changement d'identité révoque les liens de
   réinitialisation (S04) et prévient l'ancienne adresse.
4. **Le serveur recalcule ce que la caisse affirme** : cohérence du règlement (C01), heure du
   serveur pour l'estimation (C06). Une vente tardive est **régularisée, jamais réécrite** :
   mouvement de stock compensatoire après un inventaire (C04), écriture de régularisation après
   une clôture validée (C02). Ces écritures restent immuables (ADR 0008).
   **Ce qui se fait en même temps se sérialise sur la ligne qui fait foi** :
   - une opération de caisse verrouille sa session en partage, et la clôture la verrouille en exclusif ;
   - la validation d'un inventaire verrouille ses produits, et une vente verrouille les siens par
     identifiant croissant ;
   - une contre-passation verrouille l'écriture d'origine.
   La date qui sépare « compté » et « arrivé après » est celle de l'horloge de la base au moment de
   l'écriture (`clock_timestamp()`), jamais le début de la transaction. Un rapprochement bancaire qui a
   crédité une cagnotte ne se détache pas.
5. **Les pièces privées ne passent pas par la route publique des médias** (C05/S03).
6. **Le poste partagé oublie les données personnelles à la déconnexion**, sauf ce que le serveur
   n'a pas encore reçu (S05).
7. **Le serveur n'appelle que des destinations connues** : services de notification des
   navigateurs en HTTPS (S07).
8. **Le rôle de l'application n'a aucun droit sur la structure** (D01). `episoft_owner` possède
   tout et applique les migrations ; `episoft_app` lit et écrit les données et ne peut qu'ajouter
   aux journaux. L'anonymisation passe par `scrub_member()` en `SECURITY DEFINER`. Les tests de
   l'API rejouent `deploy/db/split-roles.sql` et tournent avec ce rôle.
9. **Les copies de sauvegarde qui quittent le serveur sont chiffrées** (`age`, clé publique seule
   sur le serveur) (C07).
10. **zod 4** : un PATCH se construit avec `patchOf()`, jamais avec `.partial()`, qui remplirait
    les valeurs par défaut des champs absents.
11. **Durcissements généraux** :
    - session exigée dès que la route est reconnue, avant la lecture du corps de la requête ;
    - limite de débit globale par session **réellement ouverte** (sinon par adresse), jamais par
      valeur de cookie envoyée par le client ;
    - nouvelle session à chaque connexion ;
    - signature binaire des fichiers téléversés ;
    - taille décompressée des classeurs vérifiée avant lecture ;
    - audit des dépendances de production bloquant dans la CI.

## Conséquences

- Un ADHERENTS ne peut plus corriger le courriel d'un bénévole qui a un rôle : il demande à un
  ADMIN. C'est voulu.
- La bascule des rôles de la base et le choix de la destination des copies chiffrées demandent une
  intervention sur le serveur, avec l'accord du responsable (`docs/maintenance.md`).
- Une nouvelle route, une nouvelle table ou une migration qui demanderait plus de droits fait
  échouer les tests : c'est le signal pour décider explicitement.
