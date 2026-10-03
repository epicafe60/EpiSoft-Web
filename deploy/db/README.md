# EpiSoft-Web — PostgreSQL 17

This is a separate instance for the v2 app. It never touches the production MariaDB (EpiSoft).

## Local (current)

Runs on this PC with Docker Desktop. It is reachable from this PC only, at `127.0.0.1:5432`.

| | |
|---|---|
| Database | `episoft`, schema `app` |
| `episoft_app` | read/write, used by the application |
| `episoft_ro` | read-only (reports, exports) |
| `postgres` | superuser, for administration only |

The passwords are in `.env`. That file is generated locally, never committed, and listed in `.gitignore`.

Connection string for the app:
`postgres://episoft_app:<EPISOFT_APP_PASSWORD>@127.0.0.1:5432/episoft`

Commands (run in this folder):

```
docker compose up -d                                        # start
docker compose stop                                         # stop (data kept)
docker compose ps                                           # status
docker exec -it episoft-web-postgres psql -U postgres -d episoft   # SQL console
bash backup.sh                                              # dump into ./backups (on Windows: run from Git Bash)
```

The data lives in the Docker volume `episoft-web-pgdata`, so it survives `docker compose down`.
Only `docker compose down -v` deletes it.

## Server (later)

Target: the MinisForum, Debian 13, 192.168.1.10. **It also hosts the production MariaDB.**

1. Copy this folder to the server.
2. Run `sudo bash setup.sh` (check only).
3. Run `sudo bash setup.sh --install`.

See the comments in `setup.sh`. Only the Docker packages are installed. MariaDB is not touched. The port is published on the LAN IP only and must never be forwarded on the router.
