# Maintenance guide

For the volunteers who keep EpiSoft-Web running (EV-T01). French is used for the business
vocabulary and the screens; code, commits and this guide are in English.

## Skills that help

- **Everyday care**: reading a log, restarting a service, restoring a backup (see below). No code.
- **Small fixes and evolutions**: TypeScript, React, SQL (PostgreSQL). The business rules are
  pure functions in `packages/shared`, with tests: start there.
- **Reference**: `docs/specifications.md` (what the app must do), `docs/adr/` (why it is built
  this way), `docs/evols/` (the needs raised before the migration).

## Run it locally

See the README: Docker Desktop for the database, `pnpm install`, `pnpm db:migrate`, `pnpm dev`.
Before sending a change: `pnpm typecheck`, `pnpm test`, `pnpm e2e`, `pnpm lint`.

## Backups and restore

What runs, and what tells you when it does not:

- `deploy/db/backup.sh` dumps the database every night, **checks that the dump can be read back**,
  records a checksum, copies it **off the server** when `BACKUP_RSYNC_DEST` or `BACKUP_RCLONE_DEST`
  is set, or onto an **external disk** when `BACKUP_DISK_MOUNT` is set and the disk is mounted (a disk
  that is not mounted is reported and the script exits 1), keeps the last 14 days, and **reports the result to the application** (Surveillance ›
  Sauvegardes). A failed or missing backup shows in « À surveiller » and is e-mailed to the
  administrators.
- `deploy/db/restore-test.sh` runs on the 1st of each month: it **restores the latest backup into a
  scratch database**, compares it with the live data, checks that no row points to nothing (the
  integrity check REF-01) and that the cagnotte balances agree. A backup never restored is only a hope.
- Both scripts share `deploy/db/lib.sh`, which works in two modes:
  - `PG_MODE=native` — **the production server**: PostgreSQL installed on the machine, run as the
    `postgres` user, dumps in `/var/backups/episoft`. The scripts run as root (systemd units below).
  - `PG_MODE=docker` (default) — a development machine: the `episoft-web-postgres` container, dumps in
    `deploy/db/backups`.

Install on the production server (once, with sudo; it replaces the nightly dump set up at go-live):

```
sudo install -m 600 /dev/null /etc/episoft/backup.env    # then edit it:
#   BACKUP_API_URL=http://127.0.0.1:3000
#   BACKUP_REPORT_TOKEN=<same value as in /etc/episoft/api.env>
#   PG_MODE=native
#   BACKUP_DISK_MOUNT=/mnt/sauvegarde/disque   (the external disk of the server; 30 days kept there)
#   BACKUP_RSYNC_DEST=user@other-machine:/backups/episoft/   (or BACKUP_RCLONE_DEST=…, optional)
sudo cp /opt/episoft-web/src/deploy/db/episoft-*.service /opt/episoft-web/src/deploy/db/episoft-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now episoft-backup.timer episoft-restore-test.timer
sudo systemctl start episoft-backup.service       # a first run now, to check
journalctl -u episoft-backup.service -n 20         # what it said
systemctl list-timers 'episoft-*'                  # next runs
```

- The server has **no `curl`**: the report is then sent with Node (`/opt/node/bin/node`, or `NODE_BIN`),
  the token being read from the environment, never from a command line.
- The nightly script set up at go-live (`/usr/local/bin/episoft-backup.sh`, files named
  `episoft-…dump`) is kept as `.old` when this one takes over. Files named `episoft-…` are never
  deleted by the new script (it only manages `episoft_…`): remove the old ones by hand when you wish.
- **A copy outside the server is the whole point**: the dumps sit on the same eMMC as the database, and
  a backup on the same disk does not survive a dead disk. Check that the « copiée hors du serveur »
  line appears on the Sauvegardes page.
- `/var/backups/episoft` belongs to `postgres` (mode 700): the `episoft` account cannot read it; use sudo.

Restore, after a disaster (the dump is in PostgreSQL « custom » format: it needs `pg_restore`, not
`psql`). On the production server:

```
sha256sum -c /var/backups/episoft/episoft_YYYY-MM-DD_HHMM.dump.sha256   # the file is intact
sudo systemctl stop episoft-web                                        # stop the application
sudo -u postgres dropdb --if-exists episoft
sudo -u postgres createdb -O episoft_app episoft
sudo -u postgres pg_restore -d episoft --no-owner --role=episoft_app \
  /var/backups/episoft/episoft_YYYY-MM-DD_HHMM.dump
sudo systemctl start episoft-web
```

Then open Administration › Contrôles: every check should be green.

After the switch of the database roles (below), restore as the owner and give the rights back:
`createdb -O episoft_owner episoft`, `pg_restore … --no-owner --no-acl --role=episoft_owner`, then
replay `split-roles.sql` (it is safe to run again).

### Encrypted copies (audit KV2, C07)

The dump holds everything: members, addresses, balances, password hashes. A copy that leaves the
server (another machine, a cloud folder, the external disk) is encrypted with
[age](https://age-encryption.org) when `BACKUP_AGE_RECIPIENT` is set in `/etc/episoft/backup.env`:

```
age-keygen -o episoft-backup.key        # on YOUR computer, not on the server
#   prints « Public key: age1… »: that line goes into backup.env as BACKUP_AGE_RECIPIENT=age1…
sudo apt install age                    # on the server (Debian package)
```

- Only the **public** key is on the server: whoever takes the server or a copy cannot read the copies.
- Keep the private key file in two places that are not the server (a password manager, a USB key
  in the association's safe). **Without it, the encrypted copies cannot be read by anybody.**
- The server keeps its own dumps in clear (`/var/backups/episoft`, readable by `postgres` only): the
  monthly restore test reads them.
- When `BACKUP_AGE_RECIPIENT` is set but `age` is missing, the backup fails and is reported: a copy
  is never sent in clear by mistake.

Restore from an encrypted copy, on any machine with PostgreSQL 17 (or Docker Desktop, below):

```
sha256sum -c episoft_YYYY-MM-DD_HHMM.dump.age.sha256        # the copy arrived intact
age -d -i episoft-backup.key -o episoft_YYYY-MM-DD_HHMM.dump episoft_YYYY-MM-DD_HHMM.dump.age
sha256sum -c episoft_YYYY-MM-DD_HHMM.dump.sha256            # the decrypted dump is the original
# then pg_restore as above. On a development computer, into the Docker container:
docker cp episoft_YYYY-MM-DD_HHMM.dump episoft-web-postgres:/tmp/
docker exec episoft-web-postgres pg_restore -U postgres -d episoft --clean --if-exists \
  --no-owner --role=episoft_app /tmp/episoft_YYYY-MM-DD_HHMM.dump
```

Try it once a year on another computer, and write down the date and how long it took: it is the only
proof that the association can start again after losing the server.

## Database roles (audit KV2, D01)

Three roles, each with the least it needs:

| Role | Used by | Rights |
|---|---|---|
| `episoft_owner` | the migrations only | owns the schema, the tables, the functions and the triggers |
| `episoft_app` | the application (`DATABASE_URL`) | reads and writes the data; only **adds** to the journals (`audit_log`, `data_change`); nothing on the structure |
| `episoft_ro` | reports, tools | reads |

Why: if a flaw in the application ever let someone run SQL, they could not drop a table, switch off the
audit triggers or rewrite the journals. The RGPD anonymisation still blanks the journals through
`app.scrub_member()`, which runs with the rights of the owner (migration 0026).

Until the switch, `episoft_app` owns everything (the layout of the go-live). The switch, **on the
server, with the application stopped and after a backup** (each step needs the go-ahead of the
person in charge):

```
sudo systemctl stop episoft-web
sudo systemctl start episoft-backup.service
pw=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' 
')
# postgres cannot read /opt/episoft-web (mode 750): the script goes through standard input, and the
# password too (never on the command line).
{ printf '\set owner_pw %s
' "'$pw'"; cat /opt/episoft-web/src/deploy/db/split-roles.sql; }   | sudo -u postgres psql -d episoft -v ON_ERROR_STOP=1 -X -q -f -
sudo install -m 600 -o root -g root /dev/null /etc/episoft/migrate.env
printf 'MIGRATION_DATABASE_URL=postgresql://episoft_owner:%s@127.0.0.1:5432/episoft
' "$pw" | sudo tee /etc/episoft/migrate.env >/dev/null
unset pw
sudo sed -i 's/^MIGRATE_ON_START=.*/MIGRATE_ON_START=false/' /etc/episoft/api.env
sudo systemctl start episoft-web
```

The last lines of `split-roles.sql` show the result: `episoft_app` must read `can_create_in_app = f`,
`can_write_members = t`, `can_rewrite_journal = f`.

Then, at each deployment, the migrations are applied by the owner, before the restart, from a root
shell on the server (`sudo bash`, since `migrate.env` is readable by root only), in the folder of the new
version: `set -a; . /etc/episoft/api.env; . /etc/episoft/migrate.env; set +a; corepack pnpm --filter @episoft/db migrate`.
Done on 2026-11-08: the switch ran with the shop's application not yet in use, the check by the owner
account found 28 migrations and nothing pending. Keep
`MIGRATE_ON_START=false` in `api.env`: the owner's password then never sits in the environment of the
running application. The test suite of the API replays `split-roles.sql` on a copy of the go-live
layout and runs every test as `episoft_app`: a migration that needs more rights shows there first.

## Knowing when something is wrong

- The home page of an administrator or the treasury shows **« À surveiller »**: refused tickets,
  tickets saved with a warning, failed e-mails, a late backup, a negative stock or cagnotte, a
  session left open, the integrity checks. One summary e-mail is sent every morning; a refused
  ticket, a missed backup or a server error is e-mailed at once (once an hour at most).
- An unexpected error shows the user **a reference** (« Référence 3FA9C2 »). Surveillance › Erreurs
  du serveur finds it, with the page, the message and how many times it happened.
- The alert thresholds (what counts as an unusual quantity, amount, price, cash gap…) are in
  Administration › Paramètres › Seuils d'alerte, with a button to put the defaults back.
- For a server that is down altogether, nothing inside the application can warn you: use an
  outside monitor (for example Uptime Kuma, or a free uptime service) on `https://<address>/api/v1/health`,
  and have it e-mail an administrator.

## Security basics

- Secrets live in `.env` files, never in git. Rotate the database passwords and the session
  secret when a maintainer leaves; restart the API afterwards.
- The database port is never forwarded on the router. Only the web app is exposed, through Caddy
  (HTTPS).
- Personal data: the member export (`/api/v1/me/export`) and the consents (image, newsletter,
  ticket e-mails) are on the member sheet.
- Cashier codes (R-SES-07, ADR 0011): a volunteer who forgot theirs asks an administrator, who
  clears it in Administration › Utilisateurs (« Effacer le code caissier »); the volunteer chooses a
  new one at the till. Whether the code is required is in Administration › Paramètres
  (« Changement de caissier »). A session kept by another cashier only reaches the till's routes
  (`apps/api/src/plugins/till-routes.ts`); a route the till needs and that is missing there answers
  `403 TILL_LOCKED`.

## Hosting

The target is the MinisForum (Debian 13) that already hosts the production MariaDB. Keep the
app isolated from it (own containers, own ports). Any other host must offer PostgreSQL 17,
Node 22 and daily backups kept elsewhere.
