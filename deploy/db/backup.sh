#!/bin/bash
# Nightly dump of the EpiSoft-Web PostgreSQL database (custom format, compressed).
# Keeps 14 daily dumps in /opt/episoft-web/db/backups. Off-site copy: to be added (see spec §5.6).
set -euo pipefail
DIR=/opt/episoft-web/db/backups
STAMP=$(date +%Y-%m-%d_%H%M)
docker exec episoft-web-postgres pg_dump -U postgres -d episoft -Fc -f "/backups/episoft_$STAMP.dump"
find "$DIR" -name 'episoft_*.dump' -mtime +14 -delete
echo "Backup written: $DIR/episoft_$STAMP.dump"
