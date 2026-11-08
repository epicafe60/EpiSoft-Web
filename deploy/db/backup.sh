#!/bin/bash
# Nightly dump of the EpiSoft-Web PostgreSQL database (custom format, compressed).
#
#   1. dump, 2. check that the dump can be read back, 3. checksum, 4. optional off-site copy,
#   5. tell the application (Surveillance › Sauvegardes), 6. keep the last N days.
#
# A backup nobody checks is a hope, not a backup: the script fails loudly (exit 1) and reports
# the failure to the application, which then shows it in « À surveiller » and e-mails the admins.
#
# Settings (see lib.sh for PG_MODE and the settings file):
#   BACKUP_API_URL        where the application listens, e.g. http://127.0.0.1:3000
#   BACKUP_REPORT_TOKEN   same value as in the API environment (at least 16 characters)
#   BACKUP_RSYNC_DEST     e.g. user@other-machine:/backups/episoft/   (off-site copy with rsync)
#   BACKUP_RCLONE_DEST    e.g. mydrive:episoft-backups              (off-site copy with rclone)
#   BACKUP_DISK_MOUNT     mount point of an external disk, e.g. /mnt/sauvegarde/disque: the dump is
#                         copied there when it is mounted (BACKUP_DISK_DIR, default
#                         <mount>/EpiSoft-Backups; BACKUP_DISK_KEEP_DAYS, default 30). A disk that is
#                         not mounted is reported and makes the script exit 1, like the nightly
#                         script this one replaces.
#   BACKUP_KEEP_DAYS      default 14
#   BACKUP_AGE_RECIPIENT  public key age1… (audit KV2, C07): every copy that leaves the server (rsync,
#                         rclone, external disk) is then encrypted with age, so that a lost disk or a
#                         leaked cloud folder gives nothing away (members, balances, password hashes).
#                         Only the public key is on the server; the private key is kept elsewhere
#                         (see docs/maintenance.md). Set but age missing = failure, never a clear copy.
set -uo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

KEEP="${BACKUP_KEEP_DAYS:-14}"
STAMP=$(date +%Y-%m-%d_%H%M)
NAME="episoft_$STAMP.dump"
FILE="$DIR/$NAME"

fail() {
  echo "BACKUP FAILED: $1" >&2
  report BACKUP false null "" false false "$1"
  exit 1
}

mkdir -p "$DIR"
pg pg_dump -U postgres -d "$LIVE_DB" -Fc -f "$PG_DIR/$NAME" || fail "pg_dump a échoué"
[ -s "$FILE" ] || fail "le fichier de sauvegarde est vide ou absent"

# The dump must be readable: pg_restore --list reads its table of contents.
ENTRIES=$(pg pg_restore -l "$PG_DIR/$NAME" | grep -vc '^;') || true
[ "${ENTRIES:-0}" -gt 20 ] || fail "la sauvegarde est illisible (${ENTRIES:-0} éléments)"
SIZE=$(wc -c <"$FILE" | tr -d ' ')
SUM=$(sha256sum "$FILE" | cut -d' ' -f1)
echo "$SUM  $NAME" >"$FILE.sha256"

# What leaves the server: the dump itself, or its encrypted copy (C07). The checksum of the clear
# dump goes along in both cases, to check it once decrypted.
COPY="$FILE"
COPY_SUM="$FILE.sha256"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || fail "age n'est pas installé : pas de copie chiffrée possible"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$FILE.age" "$FILE" || fail "le chiffrement de la sauvegarde a échoué"
  echo "$(sha256sum "$FILE.age" | cut -d' ' -f1)  $NAME.age" >"$FILE.age.sha256"
  COPY="$FILE.age"
  COPY_SUM="$FILE.age.sha256"
fi

OFFSITE=false
if [ -n "${BACKUP_RSYNC_DEST:-}" ]; then
  rsync -a "$COPY" "$COPY_SUM" "$FILE.sha256" "$BACKUP_RSYNC_DEST" && OFFSITE=true ||
    fail "la copie rsync a échoué"
elif [ -n "${BACKUP_RCLONE_DEST:-}" ]; then
  rclone copy "$COPY" "$BACKUP_RCLONE_DEST" && rclone copy "$COPY_SUM" "$BACKUP_RCLONE_DEST" &&
    rclone copy "$FILE.sha256" "$BACKUP_RCLONE_DEST" && OFFSITE=true || fail "la copie rclone a échoué"
fi

DISK_MISSING=false
if [ -n "${BACKUP_DISK_MOUNT:-}" ]; then
  if mountpoint -q "$BACKUP_DISK_MOUNT"; then
    DISK_DIR="${BACKUP_DISK_DIR:-$BACKUP_DISK_MOUNT/EpiSoft-Backups}"
    mkdir -p "$DISK_DIR" && cp "$COPY" "$COPY_SUM" "$FILE.sha256" "$DISK_DIR/" ||
      fail "la copie sur le disque a échoué"
    find "$DISK_DIR" -name 'episoft_*.dump*' -mtime +"${BACKUP_DISK_KEEP_DAYS:-30}" -delete
    OFFSITE=true
  else
    DISK_MISSING=true
  fi
fi

# The encrypted copy was only made to travel: the server keeps its clear dump, not both.
[ "$COPY" != "$FILE" ] && rm -f "$COPY" "$COPY_SUM"

# Only the files this script names (episoft_…) are ever deleted.
find "$DIR" -name 'episoft_*.dump*' -mtime +"$KEEP" -delete
ENCRYPTED=$([ "$COPY" != "$FILE" ] && echo yes || echo no)
echo "Backup written: $FILE ($SIZE bytes, $ENTRIES entries, sha256 $SUM, off-site: $OFFSITE, copies encrypted: $ENCRYPTED)"
if [ "$DISK_MISSING" = true ]; then
  echo "ERROR: external disk $BACKUP_DISK_MOUNT is not mounted, no copy outside the server" >&2
  report BACKUP true "$SIZE" "$SUM" true false "$ENTRIES éléments ; disque externe non monté : pas de copie hors serveur"
  exit 1
fi
DETAIL="$ENTRIES éléments"
[ "$ENCRYPTED" = yes ] && DETAIL="$DETAIL ; copies chiffrées (age)"
report BACKUP true "$SIZE" "$SUM" true "$OFFSITE" "$DETAIL"
