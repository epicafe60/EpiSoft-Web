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
  is set, keeps the last 14 days, and **reports the result to the application** (Surveillance ›
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
#   BACKUP_RSYNC_DEST=user@other-machine:/backups/episoft/   (or BACKUP_RCLONE_DEST=…)
sudo cp /opt/episoft-web/src/deploy/db/episoft-*.service /opt/episoft-web/src/deploy/db/episoft-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now episoft-backup.timer episoft-restore-test.timer
sudo systemctl start episoft-backup.service       # a first run now, to check
journalctl -u episoft-backup.service -n 20         # what it said
systemctl list-timers 'episoft-*'                  # next runs
```

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

## Hosting

The target is the MinisForum (Debian 13) that already hosts the production MariaDB. Keep the
app isolated from it (own containers, own ports). Any other host must offer PostgreSQL 17,
Node 22 and daily backups kept elsewhere.
