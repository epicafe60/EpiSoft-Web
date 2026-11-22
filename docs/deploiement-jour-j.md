# Déploiement du jour J : migrations 0028 à 0049

Pour la personne qui déploie. Chaque commande sur le serveur demande l'accord du responsable, **à chaque
fois**. Rien ici ne s'exécute tout seul. Répété en local le 2026-11-22 sur une copie de la production
(migrations : 4 s, 0 erreur de contrôle) ; voir `docs/maintenance.md`, « Premier déploiement ».

Le commit à livrer est noté `$COMMIT` (le dernier de `main` après la dernière PR mergée). Les chemins
viennent de la production telle que relevée le 2026-11-22 : `/opt/episoft-web/src` (code, du 08/11),
`/etc/episoft/` (réglages), `/var/backups/episoft` (sauvegardes), service `episoft-web`, utilisateur `episoft`.
Les lignes marquées **[à confirmer]** reposent sur une hypothèse à vérifier avant de les lancer.

Connexion (depuis le poste de développement) :

```
ssh -i ~/.ssh/episoft_minisforum -o HostKeyAlias=192.168.1.10 episoft@192.168.1.10
```

## J-2 : décisions et préparatifs

1. **Sauvegarde hors du serveur** : la sauvegarde de 21 h échoue depuis le 18/11 (« external disk
   /mnt/sauvegarde/disque is not mounted »). Brancher et monter le disque, ou remplacer
   `BACKUP_DISK_MOUNT` par `BACKUP_RSYNC_DEST` dans `/etc/episoft/backup.env`. Contrôle : Surveillance ›
   Sauvegardes affiche « copiée hors du serveur » et `systemctl is-failed episoft-backup.service` répond `active`
   ou `inactive`, pas `failed`.
2. **Clé de scellement** : la générer **sur votre poste**, la ranger dans le gestionnaire de mots de passe et
   dans le coffre de l'association. La perdre rend les signatures invérifiables (la chaîne reste vérifiable).

   ```
   KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'); echo "$KEY"   # 64 caractères : à copier
   ```

3. **Session de caisse ouverte depuis le 20/11** : la fermer depuis la caisse (Clôture de caisse).
4. Annoncer la fenêtre aux bénévoles : boutique fermée, **toutes les caisses ont envoyé leurs opérations**
   (aucune opération en attente) avant l'heure.
5. Après le merge de la dernière PR, noter `COMMIT=$(git rev-parse --short origin/main)` et vérifier que la CI
   de ce commit est verte.

## J-1 ou en début de journée : préparation, sans rien couper

Rien ici n'arrête le service. Le code est construit à côté (`src.new`), pas dans `src`.

```
# 1. Le code, depuis le poste de développement (dans le dépôt, sur main à jour)
git archive --format=tar --prefix=src.new/ $COMMIT | ssh -i ~/.ssh/episoft_minisforum -o HostKeyAlias=192.168.1.10 \
  episoft@192.168.1.10 'cd /opt/episoft-web && rm -rf src.new && tar -x'

# 2. Sur le serveur : installer et construire (Node 22 dans /opt/node)
cd /opt/episoft-web/src.new
export PATH=/opt/node/bin:$PATH
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @episoft/web build && corepack pnpm --filter @episoft/api build   # [à confirmer] comme au 08/11
ls apps/api/dist/server.js apps/web/dist/index.html packages/db/drizzle/0049_fiscal_guards.sql

# 3. Réglages (copie de sécurité d'abord ; la clé arrive par l'entrée standard, jamais en argument)
sudo cp -p /etc/episoft/api.env /etc/episoft/api.env.bak-$(date +%Y%m%d)
sudo sed -i 's/^SMTP_FROM=\(.*\)$/SMTP_FROM="\1"/' /etc/episoft/api.env            # ligne 18 : guillemets
sudo install -d -o episoft -g episoft -m 700 /var/lib/episoft /var/lib/episoft/archives
printf 'FISCAL_SEAL_KEY=%s\nARCHIVE_DIR=/var/lib/episoft/archives\nDISK_CHECK_PATH=/var/lib/postgresql\nFISCAL_AUTOCLOSE=false\n' "$KEY" \
  | sudo tee -a /etc/episoft/api.env >/dev/null
sudo grep -c '^FISCAL_SEAL_KEY=' /etc/episoft/api.env          # doit afficher 1
sudo grep -o '^[A-Z_]*=' /etc/episoft/api.env | sort | uniq -d   # doit rester vide (pas de doublon)
```

La clé figure dans l'historique du shell de votre poste : l'effacer (`history -c`) ou la saisir depuis un
fichier. Ne jamais l'écrire dans un message.

## Jour J : la fenêtre (boutique fermée)

Vérifier avant de commencer : aucune session de caisse ouverte (Administration › Contrôles, SES-01), aucune
opération de caisse en attente, personne d'autre connecté à l'administration.

```
# 1. Sauvegarde juste avant (le service tourne encore ; le disque externe peut manquer, le dump est écrit quand même)
sudo -u postgres pg_dump -Fc episoft -f /var/backups/episoft/pre-deploy-$COMMIT-$(date +%Y%m%d-%H%M).dump
sudo sha256sum /var/backups/episoft/pre-deploy-$COMMIT-*.dump | tee /tmp/pre-deploy.sha     # noter le nom
sudo -u postgres pg_restore -l /var/backups/episoft/pre-deploy-$COMMIT-*.dump | tail -3      # lisible

# 2. Arrêt
sudo systemctl stop episoft-web

# 3. Migrations par le propriétaire (migrate.env n'est lisible que par root ; api.env n'est pas chargé)
sudo bash -c 'cd /opt/episoft-web/src.new && export PATH=/opt/node/bin:$PATH \
  && set -a && . /etc/episoft/migrate.env && set +a && corepack pnpm --filter @episoft/db migrate'
#   attendu : « Migrations appliquées. » (≈ 4 s)

# 4. Le régime exonéré (rejouable ; il affiche le nombre de tickets et de factures changés)
sudo bash -c 'cd /opt/episoft-web/src.new && set -a && . /etc/episoft/migrate.env && set +a \
  && psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -X -f deploy/db/set-vat-regime.sql'
#   attendu à la répétition : ≈ 943 tickets, 140 factures, historique « exonéré » dès 2020-08-26

# 5. Bascule du code, en gardant l'ancien pour le retour arrière
sudo bash -c 'cd /opt/episoft-web && mv src src.prev-20261108 && mv src.new src && chown -R episoft:episoft src'
#   [à confirmer] les chemins WEB_DIST et MIGRATIONS_DIR de api.env pointent dans /opt/episoft-web/src/…

# 6. Démarrage
sudo systemctl start episoft-web
sleep 8 && systemctl is-active episoft-web
sudo journalctl -u episoft-web -n 20 --no-pager | cut -c1-160    # « Server listening », et l'avertissement FISCAL_AUTOCLOSE=false
```

### Vérifications avant de rouvrir

```
node /opt/episoft-web/src/deploy/smoke.mjs https://epicafe.ddns.net     # chaque ligne « ok »
```

Dans l'application (compte administrateur) :

1. **Administration › Contrôles** : 0 erreur. Les avertissements attendus (copie du 22/11) : stocks négatifs,
   totaux de tickets migrés, foyers en découvert, écart de cagnotte (compte 411000), 2 factures/réceptions,
   un écart d'espèces. **AUD-01** (1084 lignes modifiées directement dans la base) : l'examiner et l'accepter
   avec la note « Régime de TVA exonéré, script du propriétaire, décision du 2026-11-22 ».
2. **Comptabilité › Clôtures Z › Contrôle de l'intégrité** : « Journal intact » et « signé ».
3. **Comptabilité** : le régime de TVA affiché est « exonéré » depuis le 26/08/2020.
4. **Administration › Base de données** : la page s'ouvre (espace disque lu sur `/var/lib/postgresql`).
5. **Une vente d'essai** à chaque caisse, rechargée d'abord pour recevoir la nouvelle version : en ligne, puis
   hors ligne (coupez le réseau, vendez, rétablissez-le) ; le ticket doit porter son scellé.
   Annuler ou rembourser cette vente d'essai selon la règle de la boutique.
6. **Décision go / no-go** : sinon, retour arrière (ci-dessous) **avant** de rouvrir.

## Retour arrière

Sûr tant que la boutique n'a pas rouvert : après de nouvelles ventes, il les perdrait.

```
sudo systemctl stop episoft-web
sudo bash -c 'cd /opt/episoft-web && mv src src.failed && mv src.prev-20261108 src'
sudo -u postgres dropdb --if-exists episoft
sudo -u postgres createdb -O episoft_owner episoft
sudo -u postgres pg_restore -d episoft --no-owner --no-acl --role=episoft_owner /var/backups/episoft/pre-deploy-$COMMIT-….dump
# rejouer la séparation des rôles : le mot de passe du propriétaire est celui de migrate.env (jamais affiché)
sudo bash -c 'pw=$(sed -n "s#^MIGRATION_DATABASE_URL=postgresql://episoft_owner:\([^@]*\)@.*#\1#p" /etc/episoft/migrate.env); \
  [ -n "$pw" ] || { echo "mot de passe du propriétaire introuvable : arrêt"; exit 1; }; \
  { printf "\\\\set owner_pw %s\n" "'"'"'$pw'"'"'"; cat /opt/episoft-web/src/deploy/db/split-roles.sql; } \
  | sudo -u postgres psql -d episoft -v ON_ERROR_STOP=1 -X -q -f -'
sudo systemctl start episoft-web
node /opt/episoft-web/src/deploy/smoke.mjs https://epicafe.ddns.net
```

Ce bloc a été **rejoué en local le 2026-11-22** sur une copie de la base migrée, avec le dump de la
production : retour à 28 migrations, tables fiscales absentes, propriétaire `episoft_owner`, rôle
application sans droit d'écriture sur le journal. Le test a montré un piège, d'où la ligne de garde : sans
mot de passe lu dans `migrate.env`, `split-roles.sql` **efface** le mot de passe du propriétaire (« empty
string is not a valid password, clearing password »).

## Après

- Le lendemain : le courriel du matin « À surveiller » arrive, la sauvegarde de 21 h réussit et affiche
  « copiée hors du serveur ».
- **Clôtures Z** : fermer les sessions de caisse restées ouvertes, puis décider. Soit enlever
  `FISCAL_AUTOCLOSE=false` (la tâche clôt d'un coup les ~69 journées passées, définitivement), soit clôturer
  à la main jour après jour (Comptabilité › Clôtures Z).
- Mettre à jour `docs/maintenance.md` (date, commit, migrations appliquées) et noter dans le journal du projet
  que `FISCAL_SEAL_KEY` est posée et sauvegardée hors du serveur.
- Garder `src.prev-20261108` et le dump `pre-deploy-…` au moins deux semaines.
