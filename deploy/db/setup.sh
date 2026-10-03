#!/bin/bash
# EpiSoft-Web: install the PostgreSQL 17 instance on the MinisForum (Debian 13).
#
# Safe to run several times. It NEVER touches the production MariaDB:
# no mariadb/mysql package, service, config file or data directory is modified.
#
# Usage (on the server, as a sudo-capable user):
#   sudo bash setup.sh            # pre-flight checks only (default, changes nothing)
#   sudo bash setup.sh --install  # install Docker if missing, then start PostgreSQL
set -euo pipefail

DEST=/opt/episoft-web/db
SRC="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-check}"

say() { printf '\n== %s\n' "$*"; }

say "System"
. /etc/os-release && echo "$PRETTY_NAME, kernel $(uname -r)"
echo "CPU: $(nproc) cores | RAM: $(free -h | awk '/Mem:/{print $2" total, "$7" available"}')"
df -h / | tail -1 | awk '{print "Disk /: "$4" free of "$2}'

say "Production MariaDB (read-only check, nothing is changed)"
systemctl is-active mariadb 2>/dev/null || systemctl is-active mysql 2>/dev/null || echo "service not found under systemd"
ss -ltnp 2>/dev/null | grep -E ':6382|:3306' || echo "no MariaDB listener found on 3306/6382"

say "Port 5432 (must be free for the new instance)"
if ss -ltn | grep -q ':5432 '; then echo "WARNING: 5432 already in use, set PG_PORT in .env"; else echo "free"; fi

say "Docker"
if command -v docker >/dev/null; then docker --version; docker compose version; else echo "not installed"; fi

say "Firewall"
command -v ufw >/dev/null && ufw status || echo "ufw not installed"
nft list ruleset 2>/dev/null | head -5 || true

if [ "$MODE" != "--install" ]; then
  say "Check only. Re-run with --install to proceed."
  exit 0
fi

if ! command -v docker >/dev/null; then
  say "Installing Docker Engine from the official Docker repository"
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  # Only Docker packages are installed; no upgrade of other packages (MariaDB stays as is).
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

say "Preparing $DEST"
mkdir -p "$DEST/init" "$DEST/backups"
cp "$SRC/compose.yml" "$DEST/"
cp "$SRC/init/01-episoft.sh" "$DEST/init/"
cp "$SRC/backup.sh" "$DEST/"
chmod 755 "$DEST/init/01-episoft.sh" "$DEST/backup.sh"

if [ ! -f "$DEST/.env" ]; then
  gen() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }
  LAN_IP="$(hostname -I | awk '{print $1}')"
  cat > "$DEST/.env" <<EOF
POSTGRES_PASSWORD=$(gen)
EPISOFT_APP_PASSWORD=$(gen)
EPISOFT_RO_PASSWORD=$(gen)
PG_BIND_ADDR=${LAN_IP:-127.0.0.1}
PG_PORT=5432
EOF
  chmod 600 "$DEST/.env"
  echo "Generated $DEST/.env (passwords readable by root only)"
else
  echo "Keeping existing $DEST/.env"
fi

say "Starting PostgreSQL"
cd "$DEST"
docker compose up -d
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' episoft-web-postgres)" = healthy ] && break
  sleep 2
done
docker compose ps
docker exec episoft-web-postgres psql -U postgres -d episoft -c "\dn" -c "\du"

say "Done"
echo "Database : episoft  (schema app)"
echo "Host     : $(grep PG_BIND_ADDR .env | cut -d= -f2):$(grep PG_PORT .env | cut -d= -f2)  (LAN only, do NOT forward on the router)"
echo "Users    : episoft_app (read/write), episoft_ro (read-only); passwords in $DEST/.env"
echo "Backups  : add to root crontab ->  30 2 * * * $DEST/backup.sh"
