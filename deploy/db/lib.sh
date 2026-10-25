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

# Sends it with curl, or with Node when the machine has no curl (the server does not; Node is
# there since it runs the application: NODE_BIN, else /opt/node/bin/node, else node). The token
# never goes on a command line, where any user of the machine could read it with ps: curl reads it
# from its configuration on standard input, Node from its environment.
report_with_curl() {
  printf 'header = "authorization: Bearer %s"\n' "$BACKUP_REPORT_TOKEN" |
    curl -K - -fsS -m 20 -X POST "${BACKUP_API_URL%/}/api/v1/internal/backup-report" \
      -H 'content-type: application/json' -H 'x-episoft-csrf: 1' \
      --data-binary "$1" >/dev/null
}

report_with_node() {
  local node="${NODE_BIN:-}"
  [ -n "$node" ] || { [ -x /opt/node/bin/node ] && node=/opt/node/bin/node; }
  [ -n "$node" ] || node="$(command -v node)" || return 1
  BODY="$1" "$node" -e '
    const url = process.env.BACKUP_API_URL.replace(/\/$/, "") + "/api/v1/internal/backup-report";
    fetch(url, {
      method: "POST",
      headers: {
        connection: "close",
        "content-type": "application/json",
        "x-episoft-csrf": "1",
        authorization: "Bearer " + process.env.BACKUP_REPORT_TOKEN,
      },
      body: process.env.BODY,
      signal: AbortSignal.timeout(20000),
    }).then(
      (r) => { process.exitCode = r.ok ? 0 : 1; },
      () => { process.exitCode = 1; },
    );
  '
}

report() {
  [ -n "${BACKUP_API_URL:-}" ] && [ -n "${BACKUP_REPORT_TOKEN:-}" ] || return 0
  local body
  body="$(backup_payload "$@")"
  if command -v curl >/dev/null 2>&1 && [ "${BACKUP_REPORT_CLIENT:-}" != node ]; then
    report_with_curl "$body"
  else
    report_with_node "$body"
  fi || echo "warning: could not report to the application" >&2
}
