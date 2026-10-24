#!/bin/bash
# Monthly restore test: proves the latest backup can really be restored, in a scratch database
# that is dropped afterwards. The live database is only read.
#
#   bash restore-test.sh              # latest dump of the backup folder
#   bash restore-test.sh path/to.dump # a given dump (must be in the backup folder)
#
# It checks that the restored copy holds the data (same key tables, not empty, not far from the
# live counts), that it has no row pointing to nothing, and that the cagnotte balances of the copy
# agree with its own movements. The result is reported to the application like a backup.
set -uo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SCRATCH=episoft_restore_test
ERR="$(mktemp)"

psql_() { pg psql -U postgres -tA "$@"; }
cleanup() {
  psql_ -d postgres -c "drop database if exists $SCRATCH" >/dev/null 2>&1
}
fail() {
  echo "RESTORE TEST FAILED: $1" >&2
  report RESTORE_TEST false null "" false false "$1"
  cleanup
  rm -f "$ERR"
  exit 1
}

DUMP="${1:-$(ls -1t "$DIR"/episoft_*.dump 2>/dev/null | head -1)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || fail "aucune sauvegarde à tester"
NAME="$(basename "$DUMP")"
if [ -f "$DIR/$NAME.sha256" ]; then
  (cd "$DIR" && sha256sum -c "$NAME.sha256" >/dev/null 2>&1) || fail "la somme de contrôle de $NAME ne correspond plus"
fi

cleanup
psql_ -d postgres -c "create database $SCRATCH" >/dev/null || fail "impossible de créer la base de test"
# Roles of the live database may not all exist: ownership is not what is being tested.
pg pg_restore -U postgres -d "$SCRATCH" --no-owner --no-privileges "$PG_DIR/$NAME" >/dev/null 2>"$ERR" || true
if grep -qi "^pg_restore: error" "$ERR"; then
  fail "la restauration a signalé des erreurs : $(grep -i -A1 '^pg_restore: error' "$ERR" | head -2 | tr '\n' ' ')"
fi

DETAIL=""
for TABLE in member household sale sale_line wallet_entry product stock_movement entry; do
  LIVE=$(psql_ -d "$LIVE_DB" -c "select count(*) from app.$TABLE") || fail "table $TABLE illisible (base vivante)"
  COPY=$(psql_ -d "$SCRATCH" -c "select count(*) from app.$TABLE") || fail "table $TABLE absente de la copie restaurée"
  # The dump is older than the live data by up to a day: it may hold fewer rows, never none, never more.
  [ "$COPY" -le "$LIVE" ] || fail "$TABLE : la copie ($COPY) a plus de lignes que la base vivante ($LIVE)"
  if [ "$LIVE" -gt 0 ] && [ "$COPY" -eq 0 ]; then fail "$TABLE : la copie restaurée est vide ($LIVE lignes en production)"; fi
  if [ "$LIVE" -ge 50 ] && [ $((COPY * 100)) -lt $((LIVE * 80)) ]; then
    fail "$TABLE : la copie n'a que $COPY lignes sur $LIVE"
  fi
  DETAIL="$DETAIL $TABLE=$COPY/$LIVE"
done

# No row of the copy may point to nothing (see the integrity check REF-01).
ORPHANS=$(psql_ -d "$SCRATCH" -c "select coalesce(sum(orphans), 0) from app.orphan_references()") ||
  fail "contrôle des références impossible sur la copie"
[ "$ORPHANS" = "0" ] || fail "$ORPHANS ligne(s) orpheline(s) dans la copie restaurée"

# The balances of the copy must agree with its own movements.
BAD=$(psql_ -d "$SCRATCH" -c "select count(*) from (
  select w.household_id from app.wallet_entry w group by w.household_id
  having sum(w.amount) <> coalesce((select b.balance from app.household_balance b where b.household_id = w.household_id), 0)) x") ||
  fail "calcul des cagnottes impossible sur la copie"
[ "$BAD" = "0" ] || fail "$BAD cagnotte(s) incohérente(s) dans la copie restaurée"

cleanup
rm -f "$ERR"
echo "Restore test OK: $NAME ($DETAIL )"
report RESTORE_TEST true null "" true false "$NAME :$DETAIL"
