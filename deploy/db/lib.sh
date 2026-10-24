#!/bin/bash
# Shared by backup.sh and restore-test.sh (sourced, not run).
#
# PG_MODE=docker  local development: PostgreSQL in the episoft-web-postgres container,
#                 dumps in ./backups (mounted as /backups in the container).
# PG_MODE=native  the production server: PostgreSQL installed on the machine, run as the
#                 postgres user, dumps in /var/backups/episoft.
#
# Settings are read from BACKUP_ENV_FILE (default: .env next to the scripts).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV_FILE:-$HERE/.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
export MSYS_NO_PATHCONV=1 # Git Bash on Windows must not rewrite /backups

PG_MODE="${PG_MODE:-docker}"
CONTAINER="${PG_CONTAINER:-episoft-web-postgres}"
LIVE_DB="${PG_DB:-episoft}"
if [ "$PG_MODE" = native ]; then
  DIR="${BACKUP_DIR:-/var/backups/episoft}"
  PG_DIR="$DIR" # the same folder seen by PostgreSQL
else
  DIR="${BACKUP_DIR:-$HERE/backups}"
  PG_DIR=/backups # where ./backups is mounted in the container
fi

# Runs a PostgreSQL client program as the database administrator, whatever the mode.
pg() {
  if [ "$PG_MODE" = docker ]; then
    docker exec "$CONTAINER" "$@"
  elif [ "$(id -un)" = postgres ]; then
    "$@"
  else
    runuser -u postgres -- "$@"
  fi
}

# A JSON string: the text may hold quotes, backslashes or new lines (a pg_restore error does).
json_str() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

# The report sent to the application (Surveillance › Sauvegardes).
# backup_payload kind ok sizeBytes checksum verified offsite detail
backup_payload() {
  printf '{"kind":%s,"ok":%s,"sizeBytes":%s,"checksum":%s,"verified":%s,"offsite":%s,"detail":%s}' \
    "$(json_str "$1")" "${2:-false}" "${3:-null}" "$(json_str "${4:-}")" "${5:-false}" \
    "${6:-false}" "$(json_str "${7:-}")"
}

# Sends it. The token goes to curl through its configuration on standard input, never on the
# command line (where any user of the machine could read it with ps).
report() {
  [ -n "${BACKUP_API_URL:-}" ] && [ -n "${BACKUP_REPORT_TOKEN:-}" ] || return 0
  printf 'header = "authorization: Bearer %s"\n' "$BACKUP_REPORT_TOKEN" |
    curl -K - -fsS -m 20 -X POST "${BACKUP_API_URL%/}/api/v1/internal/backup-report" \
      -H 'content-type: application/json' -H 'x-episoft-csrf: 1' \
      --data-binary "$(backup_payload "$@")" >/dev/null ||
    echo "warning: could not report to the application" >&2
}
