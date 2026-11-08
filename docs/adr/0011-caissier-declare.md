# ADR 0011 — Changer de caissier sans se déconnecter

Date : 2026-11-08. Statut : accepté (fait en local, à déployer).

## Contexte

Le caissier d'un ticket était la personne connectée (R-VTE-01) : changer de caissier imposait de se
déconnecter puis de ressaisir identifiant et mot de passe. Les caissiers se relaient sans cesse, et ce
geste est trop lourd pour des bénévoles peu habitués à l'informatique. L'ancien changement par badge
(R-AUTH-04) avait été retiré ; les utilisateurs demandent un modèle « déclaratif ».

## Décision

1. **On sépare deux notions.**
   - **La session** porte les droits : c'est la personne connectée, A.
   - **Le caissier**, B, est le nom inscrit sur les tickets : c'est une **attribution**.
   - On change de caissier en touchant son nom dans « Qui encaisse ? ».
2. **Un code caissier de 4 chiffres**, exigé selon le réglage `pos.cashierSwitch.requirePin`, activé
   par défaut.
   - Chacun choisit son code avec son mot de passe EpiSoft.
   - Le serveur le stocke en PBKDF2-SHA256, avec 100 000 itérations et un sel par membre
     (`member.till_password_*`).
   - Le poste en garde une copie hachée pour le vérifier hors ligne : cette copie n'existe que pour
     les caissiers, et la déconnexion l'efface.
   - Le code ne permet **jamais** de se connecter.
3. **Le journal nomme les deux personnes.**
   - `actor_id` est le caissier B, `via_session_of_id` est la session de A.
   - `after.cashierCheck` donne le niveau de preuve : `PIN` (code vérifié), `DECLARED` (non vérifié),
     `SESSION` (A tient lui-même la caisse).
   - Un caissier seulement déclaré alors que le code est exigé déclenche l'avertissement
     `CASHIER_UNCHECKED` sur le ticket, qui apparaît dans « Tickets à vérifier ».
   - La vente n'est jamais bloquée : un ticket fait hors ligne ne doit pas se perdre.
4. **La session est restreinte à la caisse dès que B la tient** (`session.till_cashier_id`).
   - La restriction est posée par `POST /pos/cashier`, ou par le premier ticket de B reçu par
     `/sync/push`, ce qui couvre aussi un changement fait hors ligne.
   - Toute route hors de la liste `TILL_ROUTES` répond alors 403 `TILL_LOCKED`.
   - Le mot de passe de A la lève (`POST /auth/unlock`), et compte dans le verrouillage des connexions.
   - Un découvert forcé, ou l'annulation d'un ticket d'une session précédente, exigent que A tienne
     lui-même la caisse.
5. **La clôture est au nom de celui qui a compté le tiroir.** Elle se fait en ligne, et le serveur
   vérifie le code.
6. **Après 15 minutes sans ticket**, le poste redemande qui encaisse, quand le code est exigé.

## Risques acceptés

- **Un code de 4 chiffres retrouvé à partir de sa copie hachée.** Tout compte avec le rôle Caisse
  reçoit cette copie en synchronisant (`/sync/snapshot`), sans avoir besoin du poste : avec
  10 000 combinaisons, le hachage lent ne retarde que de quelques minutes celui qui la teste hors
  ligne. Le code ne permet que d'encaisser ou de clôturer au nom de B, jamais de se connecter ni
  d'utiliser les droits de B ; l'attribution reste tracée (`via_session_of_id`). Pour supprimer ce
  risque, il faudrait renoncer à la vérification hors ligne : un caissier choisi sans réseau serait
  alors toujours « déclaré ».
- **Un caissier qui en désigne un autre à tort ou exprès** n'écrit jamais au nom de quelqu'un qui
  n'a pas le rôle Caisse : le journal garde alors l'auteur réel. Les essais de code sont comptés par
  couple (personne connectée, caissier), pour qu'un collègue qui devine ne bloque pas l'usage normal.
- **Un code partagé entre bénévoles.** C'est une question de comportement, comme pour un code de
  carte bancaire.
- **Sans code exigé**, le caissier est seulement déclaré. Le journal le dit, en orange : « non
  vérifié ».

## Conséquences

- Une route que la caisse doit appeler s'ajoute à `apps/api/src/plugins/till-routes.ts`, sinon elle
  répond `TILL_LOCKED` dès qu'un autre caissier tient la caisse. `test/route-access.test.ts` vérifie
  cette liste.
- Un code oublié s'efface dans Administration › Utilisateurs ; le bénévole en choisit un nouveau à la
  caisse.
